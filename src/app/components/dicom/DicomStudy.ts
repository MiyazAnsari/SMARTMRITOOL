import {
  DicomVolume,
  Plane,
  groupFilesByDirectory,
  isProbablyDicom,
  loadDicomSeries,
  readLateralityFromDicomBuffer,
} from './DicomLoader';
import {
  type Laterality,
  detectSeriesLaterality,
  lateralityFromSeriesText,
  resolveLateralityForPlane,
} from './laterality';

export interface KneeSequences {
  volumes: Partial<Record<Plane, DicomVolume>>;
}

export interface DicomStudy {
  studyName: string;
  patientId: string;
  patientName: string;
  studyInstanceUID: string;
  /** Opaque token shared by every study loaded in the same top-level folder
   *  pick.  Two studies with the same batchId are guaranteed to be different
   *  patients and must never be merged via PatientID matching. */
  batchId?: string;
  knees: {
    left: KneeSequences;
    right: KneeSequences;
  };
}

export function emptyKnees(): DicomStudy['knees'] {
  return { left: { volumes: {} }, right: { volumes: {} } };
}

export function mergeStudies(existing: DicomStudy, incoming: DicomStudy): DicomStudy {
  const knees = emptyKnees();
  for (const lat of ['left', 'right'] as Laterality[]) {
    const bucket = knees[lat].volumes;
    for (const p of ['axial', 'sagittal', 'coronal'] as Plane[]) {
      const prev = existing.knees[lat].volumes[p];
      const next = incoming.knees[lat].volumes[p];
      if (prev && (!next || prev.sliceCount >= next.sliceCount)) {
        bucket[p] = prev;
      } else if (next) {
        bucket[p] = next;
      }
    }
  }

  return {
    ...existing,
    studyName: incoming.studyName || existing.studyName,
    patientId: incoming.patientId || existing.patientId,
    patientName: incoming.patientName || existing.patientName,
    studyInstanceUID: incoming.studyInstanceUID || existing.studyInstanceUID,
    batchId: existing.batchId || incoming.batchId,
    knees,
  };
}

const PLANE_HINTS: Array<{ pattern: RegExp; plane: Plane }> = [
  { pattern: /(^|\W)a[_\s-]*dicom(\W|$)|axial|tra(?:nsverse)?|^ax\b/i, plane: 'axial' },
  { pattern: /(^|\W)s[_\s-]*dicom(\W|$)|sagittal|^sag\b/i, plane: 'sagittal' },
  { pattern: /(^|\W)c[_\s-]*dicom(\W|$)|coronal|^cor\b/i, plane: 'coronal' },
];

function planeFromName(name: string): Plane | null {
  for (const { pattern, plane } of PLANE_HINTS) {
    if (pattern.test(name)) return plane;
  }
  return null;
}

/** Scan every path segment (folder or file name) for A_/S_/C_DICOM-style hints. */
function planeHintFromRelativePath(rel: string): Plane | null {
  const norm = rel.replace(/\\/g, '/');
  for (const segment of norm.split('/')) {
    if (!segment) continue;
    const p = planeFromName(segment);
    if (p) return p;
  }
  return null;
}

function assignVolume(
  knees: DicomStudy['knees'],
  laterality: Laterality,
  plane: Plane,
  vol: DicomVolume,
) {
  vol.laterality = laterality;
  const bucket = knees[laterality].volumes;
  const existing = bucket[plane];
  if (!existing || vol.sliceCount > existing.sliceCount) {
    bucket[plane] = vol;
  }
}

/**
 * Move volumes that sit in the wrong knee bucket according to series metadata.
 * Bilateral studies keep both left and right sequences (never delete the other side).
 */
function rebalanceKneesFromMetadata(knees: DicomStudy['knees']): void {
  for (const plane of ['axial', 'sagittal', 'coronal'] as Plane[]) {
    for (const lat of ['left', 'right'] as Laterality[]) {
      const vol = knees[lat].volumes[plane];
      if (!vol) continue;

      const detected = lateralityFromSeriesText(vol.seriesDescription);
      if (!detected || detected === lat) continue;

      const dest = knees[detected].volumes[plane];
      if (!dest || vol.sliceCount > dest.sliceCount) {
        vol.laterality = detected;
        knees[detected].volumes[plane] = vol;
      }
      delete knees[lat].volumes[plane];
    }
  }
}

/**
 * Load a full knee-MRI study (folder containing A_DICOM, S_DICOM, C_DICOM
 * subfolders, optionally under LeftKnee/RightKnee) by reading every file once
 * and grouping by parent directory.
 */
export async function loadDicomStudy(
  fileList: FileList | File[],
  onProgress?: (msg: string) => void,
  studyNameOverride?: string,
): Promise<DicomStudy> {
  const files = Array.from(fileList).filter((f) => isProbablyDicom(f.name));
  const groups = groupFilesByDirectory(files);

  const firstRel = ((files[0] as File & { webkitRelativePath?: string })?.webkitRelativePath || files[0]?.name || 'Study').replace(/\\/g, '/');
  let studyName = studyNameOverride || firstRel.split('/')[0] || 'Study';

  // If the folder-derived name looks like a laterality folder (LeftKnee /
  // RightKnee), a DICOM plane folder (A_DICOM / S_DICOM / C_DICOM), or a bare
  // filename with an extension, defer to the DICOM PatientName (or PatientID)
  // which we will have after parsing the series below.
  const isGenericFolderName =
    /^(left|right)[\s_-]*knee|knee[\s_-]*(left|right)|^(lk|rk)$/i.test(studyName) ||
    /^[asc][_\s-]*dicom$/i.test(studyName) ||
    /\.[a-z0-9]{1,6}$/i.test(studyName);

  const knees = emptyKnees();

  for (const [dir, dirFiles] of groups) {
    onProgress?.(`Reading ${dir || 'series'} (${dirFiles.length} files)…`);
    const buffers = await Promise.all(
      dirFiles.map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() })),
    );

    const firstRelPath =
      ((dirFiles[0] as File & { webkitRelativePath?: string })?.webkitRelativePath || dirFiles[0]?.name || '').replace(/\\/g, '/');
    const dirHint = planeFromName(dir.split('/').pop() || dir);
    const pathHint = planeHintFromRelativePath(firstRelPath);

    // Pass folder-name hints to loadDicomSeries — detectPlane will use them
    // only as a last resort after IOP and SeriesDescription.
    const vol = await loadDicomSeries(buffers, (dirHint ?? pathHint) || undefined, 'left', {
      allowedModalities: ['MR'],
    });
    if (!vol) continue;

    // DICOM-determined plane (from IOP) is authoritative; folder hints are
    // already incorporated by detectPlane as a fallback — don't override.
    // Only use the raw folder hint if vol.plane is still the hardcoded
    // default (meaning IOP was absent AND SeriesDescription had no clue).
    if (
      vol.plane === 'axial' &&
      !vol.seriesDescription &&
      (dirHint || pathHint)
    ) {
      vol.plane = (dirHint ?? pathHint)!;
    }

    const dicomLat = buffers[0] ? readLateralityFromDicomBuffer(buffers[0].buffer) : null;
    const latHint = detectSeriesLaterality(
      vol.seriesDescription,
      `${dir}/${firstRelPath}`,
      studyName,
      dicomLat ?? undefined,
    );
    const occupied = {
      left: Boolean(knees.left.volumes[vol.plane]),
      right: Boolean(knees.right.volumes[vol.plane]),
    };
    const laterality = resolveLateralityForPlane(latHint, vol.plane, occupied);
    assignVolume(knees, laterality, vol.plane, vol);
  }

  rebalanceKneesFromMetadata(knees);

  const representative = (['left', 'right'] as Laterality[])
    .flatMap((lat) => (['axial', 'sagittal', 'coronal'] as Plane[]).map((p) => knees[lat].volumes[p]))
    .find(Boolean);

  // When the folder-derived study name is a generic label (laterality folder,
  // plane folder, or bare filename), use the DICOM PatientName / PatientID
  // instead so the UI shows something meaningful.
  const resolvedStudyName =
    isGenericFolderName && representative
      ? representative.patientName && representative.patientName !== 'Unknown Patient'
        ? representative.patientName
        : representative.patientId || studyName
      : studyName;

  return {
    studyName: resolvedStudyName,
    patientId: representative?.patientId || `unknown-${resolvedStudyName}`,
    patientName: representative?.patientName || 'Unknown Patient',
    studyInstanceUID: representative?.studyInstanceUID || '',
    batchId: undefined, // set by caller when loading multiple patients in one batch
    knees,
  };
}
