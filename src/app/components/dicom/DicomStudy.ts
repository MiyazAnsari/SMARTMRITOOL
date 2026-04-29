import {
  DicomVolume,
  Plane,
  groupFilesByDirectory,
  isProbablyDicom,
  loadDicomSeries,
} from './DicomLoader';

export interface DicomStudy {
  studyName: string;
  /** One volume per orientation. Any of these can be undefined if missing. */
  volumes: Partial<Record<Plane, DicomVolume>>;
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

/**
 * Load a full knee-MRI study (folder containing A_DICOM, S_DICOM, C_DICOM
 * subfolders) by reading every file once and grouping by parent directory.
 */
export async function loadDicomStudy(
  fileList: FileList | File[],
  onProgress?: (msg: string) => void,
): Promise<DicomStudy> {
  const files = Array.from(fileList).filter((f) => isProbablyDicom(f.name));
  const groups = groupFilesByDirectory(files);

  // The study name = the topmost shared directory
  const firstRel = (files[0] as any)?.webkitRelativePath || files[0]?.name || 'Study';
  const studyName = firstRel.split('/')[0] || 'Study';

  const volumes: Partial<Record<Plane, DicomVolume>> = {};

  for (const [dir, dirFiles] of groups) {
    onProgress?.(`Reading ${dir || 'series'} (${dirFiles.length} files)…`);
    const buffers = await Promise.all(
      dirFiles.map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() })),
    );

    // Hint plane from the directory name (more reliable than per-file metadata
    // when folders are explicitly named A_DICOM / S_DICOM / C_DICOM).
    const dirHint = planeFromName(dir.split('/').pop() || dir);
    const vol = await loadDicomSeries(buffers, dirHint || undefined);
    if (!vol) continue;

    // If the directory hint disagrees with the orientation we detected, trust
    // the directory hint (Danish's convention: A_DICOM, S_DICOM, C_DICOM).
    const finalPlane = dirHint ?? vol.plane;
    vol.plane = finalPlane;

    // If we already filled this plane, keep the larger series.
    const existing = volumes[finalPlane];
    if (!existing || vol.sliceCount > existing.sliceCount) {
      volumes[finalPlane] = vol;
    }
  }

  return { studyName, volumes };
}
