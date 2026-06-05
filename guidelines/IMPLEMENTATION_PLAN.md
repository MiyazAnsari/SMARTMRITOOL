# Reference Line System — Implementation Plan

> Priority order: issues that affect measurement accuracy or block features come first.
> Each issue includes root cause analysis, proposed fix, affected files, and verification steps.

---

## 🔴 P0 — Fix 3D Affine Matrix Inversion (Unblocks Coronal Lines)

**Impact:** Coronal reference lines are currently suppressed. The 3D affine is the *only* way to get anatomically correct cross-plane positioning because sagittal Y (L/R+Z) and coronal Y (A/P) are fundamentally different axes.

### Root Cause
`patientToVoxel()` in `dicom/dicomAffine.ts` inverts the 3×3 direction×spacing matrix M. For oblique slice geometries, one row of M can have near-zero entries (e.g., `m22 ≈ 0`), making the matrix near-singular. The current implementation computes the general 3×3 inverse but produces negative voxel indices.

### Debug Data (from last test)
```
Coronal M matrix:
  m00=0.364  m01≈0     m02=70.3    (dr×rowDir components)
  m10=0.025  m11≈0     m12=-4.9    (dc×colDir components)
  m20≈0      m21=-0.365  m22=0     (ds×sliceDir components)

det = -1.307  (non-zero, not singular)
patient = [307, 82, 16], IPP = [78, -69, 62]
dXYZ = [229, 151, -46]
result.slice = -6.1  (should be 0–66)
```

### Proposed Fix

**Option A: Use transpose instead of inverse (if M is orthonormal)**
The direction vectors (rowDir, colDir, sliceDir) should form an orthonormal basis. If they do, M⁻¹ = Mᵀ after scaling. Verify orthonormality first, then simplify:
```javascript
// Instead of full 3×3 inverse:
const invRow0 = [rowDir[0]/dr, rowDir[1]/dr, rowDir[2]/dr]
const invRow1 = [colDir[0]/dc, colDir[1]/dc, colDir[2]/dc]
const invRow2 = [sliceDir[0]/ds, sliceDir[1]/ds, sliceDir[2]/ds]
// Then: [r,c,s] = invM × (patient - IPP) using dot products
```

**Option B: Debug the full inverse step-by-step**
1. Add round-trip test: `voxelToPatient(v, A)` → `patientToVoxel(p, A)` should return `v`
2. Check each element of the inverse matrix for NaN/Inf
3. Verify that `M × M⁻¹ ≈ I` (within floating-point tolerance)
4. If matrix is valid but result is wrong, the issue is in the affine parameters (wrong IOP, IPP, or spacing)

**Option C: Use a library**
Use a well-tested linear algebra library (e.g., `gl-matrix`) for the 3×3 inverse instead of hand-rolled code.

### Affected Files
- `src/app/components/dicom/dicomAffine.ts` — fix `patientToVoxel()`
- `src/app/components/MedicalImageViewer.tsx` — uncomment 3D affine block in `referenceLineFraction`

### Verification
1. Round-trip test: `patientToVoxel(voxelToPatient([100,50,10], sagAffine), sagAffine)` → `[100,50,10]`
2. Known point test: map a sagittal point at known anatomy (e.g., center of patella) and verify coronal position
3. `coronalImageY` should be in range `[0, coronalSliceCount-1]`
4. Coronal reference line should track sagittal point dragging

---

## 🟠 P1 — Fix Axial Navigation Z-Accuracy

**Impact:** The axial slice navigated to after clicking the reference line may be ~5-10mm superior of the true 3cm-above-joint position. The offset uses `pixDims[3]` (full 3D slice distance) but the actual Z component per sagittal slice may be much smaller.

### Root Cause
`planeZSpacing['sagittal']` = `pixDims[3]` = **full 3D distance** between slice centers (e.g., 3.0mm). But the Z component of moving one sagittal slice is only part of this distance — the slice direction has X, Y, and Z components.

For the example data:
- Sagittal slice direction: `[0.998, 0.07, 0]` — Z component is **0**!
- The Z progression comes from the varying IPP origins, not the uniform slice direction
- Z change per slice ≈ (IPP_Z_last − IPP_Z_first) / (sliceCount − 1) ≈ 22mm / 34 ≈ **0.65mm/slice**
- But `pixDims[3]` = 3.0mm → `offsetFraction = 30/3.0/35 = 0.286` → 10 slices → only ∼6.5mm Z change

**The offset is ~4.6× too small.** The actual 3cm offset should be 30mm / 0.65mm-per-slice ≈ 46 slices — which may exceed the image height.

### Proposed Fix

**Step 1: Compute true Z-per-slice from IPP data**
In `referenceLineFraction`, compute:
```javascript
const sagVol = studyData.volumes.sagittal
if (sagVol.header.imagePositionPatient && sagVol.header.sliceDirection) {
  const ippZ0 = sagVol.header.imagePositionPatient[2]
  const sliceCount = sagVol.header.dims[3]
  // Approximate Z-per-slice:
  //   Z_at_slice_s ≈ ippZ0 + s × ds × sliceDir[2]
  //   But IPP varies slice-by-slice, not uniformly.
  // Better: use the stored sliceSpacing from DicomLoader (IPP-delta-based)
  // and the slice direction's Z component:
  const zPerSlice = sagVol.header.sliceSpacing × abs(sagVol.header.sliceDirection[2])
  // Fallback: pixDims[3] if zPerSlice ≈ 0
  const effectiveZS = zPerSlice > 0.01 ? zPerSlice : sagVol.header.pixDims[3]
}
```

**Step 2: Use effective Z spacing for offset calculation**
```javascript
const effectiveZS = computeZPerSlice('sagittal')  // from IPP + sliceDir
offsetFraction = (offsetMm / effectiveZS) / sagSliceCount
```

**Step 3: If offset exceeds image, clamp sensibly**
If `offsetFraction > sagFraction`, the 3cm line is above the image. Clamp `refFraction` to 0 and show a visual indicator that the line is off-screen.

### Affected Files
- `src/app/components/MedicalImageViewer.tsx` — `referenceLineFraction` useMemo
- `src/app/components/Viewport.tsx` — `computedReferenceLines` (no change needed if offsetFraction is passed)

### Verification
1. Place point at known anatomical landmark (e.g., tibial plateau)
2. Click offset line → note axial slice
3. Manually scroll axial to find trochlear groove (should be ~3cm superior)
4. Compare manual slice vs. auto-navigated slice
5. The difference should be ≤ 2 slices

---

## 🟡 P2 — Fix spcY Using dInPlane Instead of dz

**Impact:** Sagittal and coronal images are rendered with **vertically compressed aspect ratio**. `getPlaneGeometry()` sets `spcY = dInPlane ≈ 0.36mm` for sagittal/coronal, but the actual slice spacing is `dz ≈ 3.0mm`. This means the image Y axis uses wrong physical scaling.

### Root Cause
```javascript
// getPlaneGeometry() for sagittal:
spacingY = dInPlane  // min(pixDims[1], pixDims[2]) ≈ 0.36mm
// Should be: pixDims[3] (dz) ≈ 3.0mm for the slice axis
```

The sagittal Y axis = slice dimension. Each pixel along Y represents one slice, spaced dz mm apart. Using dInPlane makes the image ~8× too short.

### Proposed Fix

**Option A: Use pixDims[3] for spacingY on sagittal/coronal**
```javascript
if (plane === 'sagittal' || plane === 'coronal') {
  spacingY = Number.isFinite(pixDims[3]) && pixDims[3] > 0 ? pixDims[3] : dInPlane
}
```
⚠️ **Risk:** This changes the visual appearance significantly — images will become much taller. The user may prefer the current compressed view for clinical workflow. Test visually first.

**Option B: Keep current rendering, but use correct spacing for calculations only**
Don't change `getPlaneGeometry()`. Instead, use authoritative `pixDims[3]` in all measurement/reference-line calculations (already done via `planeZSpacing`).

**Recommendation:** Start with Option B (already implemented). Option A is a UX decision.

### Affected Files
- `src/app/components/Viewport.tsx` — `getPlaneGeometry()` (Option A only)

### Verification (Option A)
1. Image should appear taller (correct aspect ratio)
2. Reference lines and measurements should still work
3. Check with a test user if the new aspect ratio is acceptable

---

## 🟢 P3 — Fix Grid Shared Header at Root

**Impact:** Currently worked around by using `planeZSpacing`/`planeZSliceCount` from `studyData.volumes`. Fixing the root cause would eliminate the need for these workarounds and make the code simpler.

### Root Cause
`ViewportGrid` passes `header={header}` (shared) to all grid viewports. Each viewport should use its plane-specific header.

### Proposed Fix
Pass per-plane headers from `studyData.volumes`:
```javascript
// In ViewportGrid, for each grid viewport:
const planeVol = studyData?.volumes[viewPlane]
<Viewport
  plane={viewPlane}
  header={planeVol?.header ?? sharedHeader}
  imageData={planeVol?.imageData ?? sharedImageData}
  ...
/>
```

This requires `studyData` to be passed to `ViewportGrid`, or the per-plane headers to be extracted before passing.

⚠️ **Risk:** `getSliceData()` uses `header.dims` for slice extraction. If the plane-specific header has different `dims` than the shared header, the extraction dimensions change. This could break image rendering if the imageData array doesn't match the new dims.

**Recommendation:** This is a medium-risk refactor. Do it after P0 and P1 are resolved. Test thoroughly with all three planes.

### Affected Files
- `src/app/components/ViewportGrid.tsx`
- `src/app/components/MedicalImageViewer.tsx`

---

## 🔵 P4 — Re-enable Coronal Reference Lines

**Impact:** After P0 (3D affine fix), coronal lines can be re-enabled.

### Steps
1. Uncomment the 3D affine block in `referenceLineFraction`
2. Change `computedReferenceLines` condition from `measurementPlane !== 'sagittal'` back to `measurementPlane === 'axial'`
3. The coronal joint line uses `coronalImageY / coronalImgH` fraction
4. The coronal offset line uses the same `offsetFraction`

### Affected Files
- `src/app/components/MedicalImageViewer.tsx`
- `src/app/components/Viewport.tsx`

---

## ⚪ P5 — Viewport Resize Invariance

**Impact:** After resizing the sagittal viewport, `sagFraction` shifts slightly because `viewportDisplaySizes` is current but `cssY` and `offsetY` are from creation time. This is a minor cosmetic issue.

### Proposed Fix
Store `drawH` and `displayH` at creation time alongside `imageScale`:
```typescript
// In StepResult, add:
creationGeometry?: { displayH: number; drawH: number }
```
Then compute `sagFraction` using stored geometry:
```javascript
const geom = sr.creationGeometry
const sagDrawH = geom?.drawH ?? (sagDisplayH - 2*sagOffsetY)
const sagFraction = (sagCssY - sagOffsetY) / sagDrawH
```

### Affected Files
- `src/app/components/measurement/MeasurementProtocols.ts` — add `creationGeometry` to `StepResult`
- `src/app/components/MedicalImageViewer.tsx` — store geometry at creation, use in `referenceLineFraction`

---

## 📋 Summary

| Priority | Issue | Effort | Risk |
|----------|-------|--------|------|
| P0 | 3D affine matrix inversion | Medium | Low — fix is isolated to `dicomAffine.ts` |
| P1 | Axial nav Z-accuracy | Small | Low — uses existing IPP data |
| P2 | spcY vs dz rendering | Small (Option B: done) / Medium (Option A) | Medium (Option A changes visuals) |
| P3 | Grid shared header root fix | Medium | Medium — changes extraction logic |
| P4 | Re-enable coronal lines | Small (after P0) | Low |
| P5 | Resize invariance | Small | Low |

**Recommended order:** P0 → P1 → P4 → P3 → P2 (Option A, with user approval) → P5
