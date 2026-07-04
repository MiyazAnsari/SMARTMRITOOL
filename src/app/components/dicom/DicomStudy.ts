import {
  DicomVolume,
  Plane,
  isProbablyDicom,
  loadDicomSeries,
  peekDicomFileMetadata,
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

/** Detect a plane from a SeriesDescription string (same rules as detectPlane). */
function planeFromSeriesDescription(desc: string | undefined): Plane | null {
  if (!desc) return null;
  const d = desc.toLowerCase();
  if (/\bax(?:ial)?\b|\btra(?:nsverse)?\b/.test(d)) return 'axial';
  if (/\bsag(?:ittal)?\b/.test(d)) return 'sagittal';
  if (/\bcor(?:onal)?\b/.test(d)) return 'coronal';
  return null;
}

/**
 * Fix volumes that landed in the wrong plane bucket because detectPlane was
 * misled by ambiguous IOP values (common for DERIVED / MPR images).  Uses
 * SeriesDescription to determine the correct plane.
 */
function resolvePlaneConflicts(knees: DicomStudy['knees']): void {
  for (const lat of ['left', 'right'] as Laterality[]) {
    for (const plane of ['axial', 'sagittal', 'coronal'] as Plane[]) {
      const vol = knees[lat].volumes[plane];
      if (!vol) continue;
      const descPlane = planeFromSeriesDescription(vol.seriesDescription);
      if (!descPlane || descPlane === plane) continue;

      // This volume's SeriesDescription says it belongs to a different plane.
      const dest = knees[lat].volumes[descPlane];
      if (!dest || vol.sliceCount > dest.sliceCount) {
        knees[lat].volumes[descPlane] = vol;
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
  const records = await Promise.all(
    files.map(async (file) => ({
      file,
      buffer: await file.arrayBuffer(),
      meta: null as ReturnType<typeof peekDicomFileMetadata>,
    })),
  );

  for (const record of records) {
    record.meta = peekDicomFileMetadata(record.buffer);
  }

  const studyName = studyNameOverride || 'Study';

  const seriesGroups = new Map<string, typeof records>();
  for (const record of records) {
    const meta = record.meta;
    if (!meta) continue;
    const key =
      meta.seriesInstanceUID ||
      (meta.studyInstanceUID
        ? `${meta.studyInstanceUID}::${meta.modality || 'UNKNOWN'}::${meta.seriesDescription || record.file.name}`
        : record.file.name);
    const arr = seriesGroups.get(key) || [];
    arr.push(record);
    seriesGroups.set(key, arr);
  }

  const knees = emptyKnees();

  for (const [seriesKey, seriesRecords] of seriesGroups) {
    if (!seriesRecords.length) continue;
    const seriesMeta = seriesRecords[0].meta;
    if (!seriesMeta) continue;
    const modality = (seriesMeta.modality || '').toUpperCase();
    if (modality && modality !== 'MR' && ['CR', 'DX', 'DR', 'XA', 'RF', 'US', 'CT', 'PT', 'NM'].includes(modality)) {
      continue;
    }

    onProgress?.(`Reading series ${seriesMeta.seriesDescription || seriesMeta.seriesInstanceUID || seriesKey} (${seriesRecords.length} files)…`);
    const buffers = seriesRecords.map((record) => ({ name: record.file.name, buffer: record.buffer }));

    const vol = await loadDicomSeries(buffers, undefined, 'left');
    if (!vol) continue;

    const latHint = detectSeriesLaterality(
      vol.seriesDescription,
      vol.dicomLateralityRaw,
    );
    const occupied = {
      left: Boolean(knees.left.volumes[vol.plane]),
      right: Boolean(knees.right.volumes[vol.plane]),
    };
    const laterality = resolveLateralityForPlane(latHint, vol.plane, occupied);
    assignVolume(knees, laterality, vol.plane, vol);
  }

  // After all series are loaded, resolve any plane collisions.  Two different
  // series may get the same plane from detectPlane (common for DERIVED / MPR
  // images where IOP is ambiguous).  Use SeriesDescription to fix mismatches:
  // if the description clearly says AX_* but the volume landed in sagittal,
  // move it to axial (unless axial is already occupied by a real axial).
  resolvePlaneConflicts(knees);

  rebalanceKneesFromMetadata(knees);

  const representative = (['left', 'right'] as Laterality[])
    .flatMap((lat) => (['axial', 'sagittal', 'coronal'] as Plane[]).map((p) => knees[lat].volumes[p]))
    .find(Boolean);

  const resolvedStudyName =
    representative?.patientName && representative.patientName !== 'Unknown Patient'
      ? representative.patientName
      : representative?.patientId || studyName;

  return {
    studyName: resolvedStudyName,
    patientId: representative?.patientId || `unknown-${resolvedStudyName}`,
    patientName: representative?.patientName || 'Unknown Patient',
    studyInstanceUID: representative?.studyInstanceUID || '',
    batchId: undefined, // set by caller when loading multiple patients in one batch
    knees,
  };
}
