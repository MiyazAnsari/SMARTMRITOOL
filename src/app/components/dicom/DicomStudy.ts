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

    // Hint plane from folder names. When the user selects a single series folder,
    // webkitRelativePath is often flat ("0001.dcm") so the parent folder name is
    // missing from `dir` — scan the full relative path of the first file too.
    const firstRel =
      (dirFiles[0] as File & { webkitRelativePath?: string })?.webkitRelativePath ||
      dirFiles[0]?.name ||
      '';
    const dirHint = planeFromName(dir.split('/').pop() || dir);
    const pathHint = planeHintFromRelativePath(firstRel);
    const seriesHint = dirHint ?? pathHint;
    const vol = await loadDicomSeries(buffers, seriesHint || undefined);
    if (!vol) continue;

    // Prefer explicit folder/path naming over geometry heuristics.
    const finalPlane = dirHint ?? pathHint ?? vol.plane;
    vol.plane = finalPlane;

    // If we already filled this plane, keep the larger series.
    const existing = volumes[finalPlane];
    if (!existing || vol.sliceCount > existing.sliceCount) {
      volumes[finalPlane] = vol;
    }
  }

  return { studyName, volumes };
}
