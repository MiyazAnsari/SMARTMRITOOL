# Reference Line System — Complete Design Document

## 1. Data Architecture

### 1.1 Volume Storage
DICOM series are loaded independently into `studyData.volumes`:
- `studyData.volumes.sagittal` — from A_DICOM folder
- `studyData.volumes.coronal` — from C_DICOM folder  
- `studyData.volumes.axial` — from AX_DICOM folder

Each volume has:
```
DicomVolume {
  imageData: Uint8Array          // [slice][row][col], 8-bit normalized
  header: {
    dims:    [3, cols, rows, slices]   // NIfTI convention
    pixDims: [1, dx_col, dy_row, dz_slice]  // mm
    datatypeCode: 2
    scl_slope: 1, scl_inter: 0
    // DICOM spatial registration (added for 3D affine):
    imageOrientationPatient?: [r0,r1,r2, c0,c1,c2]  // row & column direction cosines
    imagePositionPatient?:    [x, y, z]               // first slice origin (mm)
    sliceDirection?:          [sx, sy, sz]            // IPP-delta-based stacking direction
    sliceSpacing?:            number                  // mm between consecutive slices (from IPP)
  }
  sliceCount: number
  plane: 'sagittal' | 'coronal' | 'axial'
}
```

### 1.2 Grid Viewport Shared Header Problem
**Critical architectural issue:** All grid viewports share a single `header` and `imageData` prop from the parent MedicalImageViewer. This header is set to whichever volume is "active" (`studyViewport.active`).

```
ViewportGrid receives:  
  header={header}          ← from studyData.volumes[studyViewport.active].header
  imageData={imageData!}   ← from studyData.volumes[studyViewport.active].imageData

Grid viewports all get:  
  <Viewport plane="sagittal"  header={sameHeader} ... />
  <Viewport plane="coronal"   header={sameHeader} ... />
  <Viewport plane="axial"     header={sameHeader} ... />
```

**Impact:** `getPlaneGeometry().height` and `computeImageScale().y` use the shared header's `dims[3]` and `pixDims[3]`, which may differ from the plane-specific authoritative values.

### 1.3 Authoritative Per-Plane Data (from studyData.volumes)
The `referenceLineFraction` useMemo collects authoritative values:

| Field | Source | Sagittal example | Coronal example |
|-------|--------|-----------------|-----------------|
| `planeZSpacing[p]` | `pixDims[3]` (dz) | 3.0mm | 0.7mm |
| `planeZSliceCount[p]` | `dims[3]` (slice count) | 35 | 67 |

These are stored in `referenceLineFraction.planeZSpacing` and `planeZSliceCount`.

---

## 2. Viewport Image Extraction

### 2.1 `getSliceData()` — How 2D slices are extracted from 3D volume

**Sagittal extraction** (fixes a column, extracts rows × slices):
```javascript
for (let z = 0; z < dims[3]; z++) {        // z = slice index → image Y
    for (let y = 0; y < dims[2]; y++) {     // y = row index  → image X
        const sourceIdx = z*dims[1]*dims[2] + y*dims[1] + currentSlice;
        sliceData[z*dims[2] + y] = imageData[sourceIdx];
    }
}
// Output: width=dims[2] (rows), height=dims[3] (slices)
```

**Coronal extraction** (fixes a row, extracts columns × slices):
```javascript
for (let z = 0; z < dims[3]; z++) {        // z = slice index → image Y
    for (let x = 0; x < dims[1]; x++) {     // x = column idx → image X
        const sourceIdx = z*dims[1]*dims[2] + currentSlice*dims[1] + x;
        sliceData[z*dims[1] + x] = imageData[sourceIdx];
    }
}
// Output: width=dims[1] (cols), height=dims[3] (slices)
```

### 2.2 `getPlaneGeometry()` — Image dimensions & spacing for rendering
```javascript
Sagittal: width = dims[2] (rows),     height = dims[3] (slices)
          spcX  = pixDims[2] (dy),    spcY   = min(p1,p2) ≈ 0.36mm

Coronal:  width = dims[1] (cols),     height = dims[3] (slices)
          spcX  = pixDims[1] (dx),    spcY   = min(p1,p2) ≈ 0.36mm

Axial:    width = dims[1] (cols),     height = dims[2] (rows)
          spcX  = pixDims[1] (dx),    spcY   = pixDims[2] (dy)
```

⚠️ **spcY for sagittal/coronal uses `dInPlane` (min of dx,dy), NOT dz.** This means the Y-axis rendering uses in-plane spacing (~0.36mm) rather than slice spacing (~3.0mm). The image appears vertically compressed.

### 2.3 `computeImageScale()` — CSS ↔ image pixel conversion
```javascript
physicalW = imgW × spcX          // physical width in mm
physicalH = imgH × spcY          // physical height in mm (uses spcY, not dz!)
fitScale  = min(dW/physicalW, dH/physicalH)
drawW     = round(physicalW × fitScale)
drawH     = round(physicalH × fitScale)
offsetX   = (dW - drawW) / 2
offsetY   = (dH - drawH) / 2

return {
  x: imgW / drawW,    // image px → CSS px scale
  y: imgH / drawH,    // image px → CSS px scale
  offsetX, offsetY
}
```

⚠️ Uses shared header's `imgW`, `imgH`, `spcX`, `spcY` — may differ from authoritative plane values.

---

## 3. Reference Line Computation Flow

### 3.1 `referenceLineFraction` (MedicalImageViewer.tsx)

**Step 1: Compute CSS fraction from sagittal point**
```javascript
const is = sr.imageScale  // stored from viewport at creation time
const sagOffsetY = is.offsetY ?? 0
const sagCssY = sr.points[0].y          // CSS Y of the point
const sagDisplayH = viewportDisplaySizes['sagittal'].height
const sagDrawH = max(1, sagDisplayH - 2 × sagOffsetY)
const sagFraction = (sagCssY - sagOffsetY) / sagDrawH   // 0=top, 1=bottom
```

**Step 2: Compute offset fraction**
```javascript
offsetFraction = (offsetMm / sagZSpacing) / sagSliceCount    // e.g. 30mm / 3.0mm / 35
```

**Step 3: Collect authoritative per-plane data**
```javascript
for each plane p:
  planeZSpacing[p]   = studyData.volumes[p].header.pixDims[3]    // dz
  planeZSliceCount[p] = studyData.volumes[p].header.dims[3]       // slice count
```

**Returned object:**
```typescript
{
  sagFraction: number          // CSS fraction 0-1 of joint line on sagittal
  sagCssY: number              // raw CSS Y of point (for sagittal exact match)
  sagOffsetY: number           // image offset at creation time
  offsetMm: number             // protocol offset (30 for 3cm)
  label: string                // "Joint line"
  planeZSpacing: Record<string, number>
  planeZSliceCount: Record<string, number>
  coronalImageY?: number       // 3D-affine-mapped Y (DISABLED pending fix)
  coronalImgH?: number         // coronal authoritative slice count
}
```

### 3.2 `computedReferenceLines` (Viewport.tsx)

**Joint line CSS Y:**
```javascript
if (isSagittal):
  jointCssY = sagCssY           // exact CSS Y match

else (coronal — DISABLED, only sagittal renders lines):
  jointCssY = sagFraction × myDrawH + myOffsetY    // same CSS fraction
```

**Offset line CSS Y:**
```javascript
sagZS    = planeZSpacing['sagittal']    // authoritative sagittal dz
sagSlices = planeZSliceCount['sagittal']  // authoritative sagittal slice count
offsetFraction = (offsetMm / sagZS) / sagSlices    // uniform fraction
offsetCss = offsetFraction × myDrawH
refCssY = jointCssY - offsetCss
```

**Click-to-navigate fraction:**
```javascript
refFraction = (refCssY - myOffsetY) / myDrawH    // 0=superior, 1=inferior
// Passed to onReferenceLineClick(refFraction)
```

### 3.3 Axial Navigation (MedicalImageViewer.tsx)
```javascript
navigateToAxialFraction(refFraction):
  axialSliceCount = studyData.volumes.axial.sliceCount
  axialFraction = 1 - refFraction      // invert: ref 0=superior → axial max=superior
  axialSlice = round(axialFraction × (axialSliceCount - 1))
```

---

## 4. DICOM Spatial Registration (for 3D Affine — WIP)

### 4.1 Affine Parameters (stored in DicomVolume.header)

From the DICOM tags:
- **ImageOrientationPatient** (0020,0037): [rowX, rowY, rowZ, colX, colY, colZ]
- **ImagePositionPatient** (0020,0032): [x, y, z] of first pixel of first slice
- **PixelSpacing** (0028,0030): [rowSpacing, colSpacing]
- **SliceThickness** (0018,0050): nominal slice gap

**Slice direction** computed from IPP deltas (NOT cross product of IOP):
```javascript
// IPP of 1st and 2nd sorted slices:
const dx = ipp0[0] - ipp1[0]
const dy = ipp0[1] - ipp1[1]
const dz = ipp0[2] - ipp1[2]
const d = sqrt(dx² + dy² + dz²)
sliceDir = [dx/d, dy/d, dz/d]
sliceSpacing = d
```

⚠️ Cross product of row/col directions gives the **plane normal**, but DICOM slices can be stacked obliquely — the IPP progression direction differs from the plane normal.

### 4.2 Voxel → Patient (Forward)
```javascript
voxelToPatient([row, col, slice], affine):
  return [
    ipp[0] + row × dr × rowDir[0] + col × dc × colDir[0] + slice × ds × sliceDir[0],
    ipp[1] + row × dr × rowDir[1] + col × dc × colDir[1] + slice × ds × sliceDir[1],
    ipp[2] + row × dr × rowDir[2] + col × dc × colDir[2] + slice × ds × sliceDir[2],
  ]
```

### 4.3 Patient → Voxel (Inverse — General 3×3 Matrix Inverse)
```javascript
// Build 3×3 matrix M = [dr×rowDir | dc×colDir | ds×sliceDir]
// M × [r,c,s]ᵀ = patient - IPP
// [r,c,s]ᵀ = M⁻¹ × (patient - IPP)

// Uses cofactor expansion for the general inverse.
// For orthonormal directions, M⁻¹ = Mᵀ after dividing rows by spacing.
// For oblique sliceDir (from IPP deltas), the full inverse is required.
```

### 4.4 Validation & Diagnostics
```javascript
// Check affine quality:
validateAffine(affine, label) → string[]
  // Verifies: direction vectors are unit length (±0.01)
  //           row·col, row·slice, col·slice ≈ 0 (orthogonal)
  //           spacings > 0
  //           determinant not near-zero
  // Logs: norms, dot products, determinant

// Round-trip test:
roundTripTest(affine, label, [rows, cols, slices]) → string[]
  // Tests: voxelToPatient → patientToVoxel at 4 sample points
  //         (origin, center, max, quarter)
  // Pass criterion: |v - roundTrip(v)| < 0.1 voxels
  // Logs: each test point, patient coords, recovered voxel, error
```

### 4.5 Cross-Plane Mapping
```javascript
mapPoint3D(srcX, srcY, srcSlice, srcAffine, dstAffine):
  srcVoxel = [srcY, srcX, srcSlice]    // [row, col, slice]
  patient = voxelToPatient(srcVoxel, srcAffine)
  dstVoxel = patientToVoxel(patient, dstAffine)
  return { x: dstVoxel[1], y: dstVoxel[0], slice: dstVoxel[2] }

// Sagittal → Coronal:
//   srcX = imgX (row), srcY = imgY (slice), srcSlice = currentSlice (column)
//   result.slice → coronal Y position (slice index)
```

---

## 5. Known Issues & Limitations

| Issue | Status | Notes |
|-------|--------|-------|
| Grid shared header mismatch | **Workaround** | Use `planeZSpacing`/`planeZSliceCount` from `studyData.volumes` |
| Coronal lines anatomically off (~3mm) | **Suppressed** | Sagittal Y = L/R+Z, Coronal Y = A/P — different axes |
| 3D affine matrix inversion | **WIP** | Produces negative slice indices; disabled in `referenceLineFraction` |
| spcY uses dInPlane not dz | **Existing** | Images rendered with compressed vertical aspect |
| sagZSpacing = pixDims[3] = 3.0mm | **Potential issue** | Full 3D slice distance vs. actual Z component per slice |

---

## 6. Key Formulas Quick Reference

```
CSS fraction:      f = (cssY - offsetY) / drawH
Joint CSS Y (sag): jointCssY = cssY_point
Joint CSS Y (cor): jointCssY = f × drawH + offsetY     (DISABLED)
Offset fraction:   oF = (30mm / sagDZ) / sagSlices
Offset CSS:        offCss = oF × drawH
Ref line CSS:      refCssY = jointCssY - offCss
Nav fraction:      navF = (refCssY - offsetY) / drawH
Axial slice:       axSlice = (1 - navF) × (axCount - 1)
```

---

## 7. Files Modified

| File | Changes |
|------|---------|
| `dicom/DicomLoader.ts` | Store IOP, IPP, sliceDir, sliceSpacing in header |
| `dicom/dicomAffine.ts` | New: voxelToPatient, patientToVoxel, mapPoint3D |
| `MedicalImageViewer.tsx` | referenceLineFraction with authoritative geometry, axial nav |
| `Viewport.tsx` | computedReferenceLines — sagittal-only, per-plane offset |
| `ViewportGrid.tsx` | Updated prop types for referenceLineFraction |
