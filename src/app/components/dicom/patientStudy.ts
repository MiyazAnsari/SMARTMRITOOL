import type { DicomStudy } from './DicomStudy';
import type { Laterality } from './laterality';
import { LATERALITIES } from './laterality';
import type { DicomVolume, Plane } from './DicomLoader';

/** Viewer-facing slice of a patient study for one knee. */
export interface DicomStudyView extends DicomStudy {
  laterality: Laterality;
  volumes: Partial<Record<Plane, DicomVolume>>;
}

export function studyViewForLaterality(study: DicomStudy, laterality: Laterality): DicomStudyView {
  return {
    ...study,
    laterality,
    volumes: study.knees[laterality].volumes,
  };
}

export function studyHasVolumes(study: DicomStudy): boolean {
  return LATERALITIES.some((lat) => Object.keys(study.knees[lat].volumes).length > 0);
}

export function firstAvailableLaterality(study: DicomStudy): Laterality {
  if (Object.keys(study.knees.left.volumes).length > 0) return 'left';
  if (Object.keys(study.knees.right.volumes).length > 0) return 'right';
  return 'left';
}

export function loadedPlanesForKnee(study: DicomStudy, laterality: Laterality): Plane[] {
  return (['axial', 'sagittal', 'coronal'] as Plane[]).filter((p) => study.knees[laterality].volumes[p]);
}

export function kneeHasVolumes(study: DicomStudy, laterality: Laterality): boolean {
  return loadedPlanesForKnee(study, laterality).length > 0;
}

/** Per-sequence metadata for export, annotation, and UI labels. */
export interface SequenceMetadata {
  patientId: string;
  laterality: Laterality;
  sequenceName: string;
  plane: Plane;
}

export function listSequenceMetadata(study: DicomStudy): SequenceMetadata[] {
  const rows: SequenceMetadata[] = [];
  for (const laterality of LATERALITIES) {
    for (const plane of ['axial', 'sagittal', 'coronal'] as Plane[]) {
      const vol = study.knees[laterality].volumes[plane];
      if (!vol) continue;
      rows.push({
        patientId: vol.patientId || study.patientId,
        laterality,
        sequenceName: (vol.seriesDescription && vol.seriesDescription.trim()) || plane,
        plane,
      });
    }
  }
  return rows;
}
