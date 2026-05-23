import type { DicomStudy } from './DicomStudy';
import type { Laterality } from './laterality';
import { LATERALITIES, lateralityForVolume } from './laterality';
import type { DicomVolume, Plane } from './DicomLoader';

/** Viewer-facing slice of a patient study for one knee. */
export interface DicomStudyView extends DicomStudy {
  laterality: Laterality;
  volumes: Partial<Record<Plane, DicomVolume>>;
}

/** Resolve the volume for a plane on the requested knee (handles mis-bucketed series). */
function volumeForKneePlane(
  study: DicomStudy,
  laterality: Laterality,
  plane: Plane,
): DicomVolume | undefined {
  const candidates: DicomVolume[] = [];
  for (const lat of LATERALITIES) {
    const vol = study.knees[lat].volumes[plane];
    if (vol) candidates.push(vol);
  }
  if (!candidates.length) return undefined;

  const bySeries = candidates.find((vol) => lateralityForVolume(vol) === laterality);
  if (bySeries) return bySeries;

  const byAssignment = candidates.find((vol) => vol.laterality === laterality);
  if (byAssignment) return byAssignment;

  return study.knees[laterality].volumes[plane];
}

export function sequenceVolumeForKnee(
  study: DicomStudy,
  laterality: Laterality,
  plane: Plane,
): DicomVolume | undefined {
  return volumeForKneePlane(study, laterality, plane);
}

export function studyViewForLaterality(study: DicomStudy, laterality: Laterality): DicomStudyView {
  const volumes: Partial<Record<Plane, DicomVolume>> = {};
  for (const plane of ['axial', 'sagittal', 'coronal'] as Plane[]) {
    const vol = volumeForKneePlane(study, laterality, plane);
    if (vol) volumes[plane] = vol;
  }
  return {
    ...study,
    laterality,
    volumes,
  };
}

export function studyHasVolumes(study: DicomStudy): boolean {
  return LATERALITIES.some((lat) => kneeHasVolumes(study, lat));
}

export function firstAvailableLaterality(study: DicomStudy): Laterality {
  for (const lat of LATERALITIES) {
    if (kneeHasVolumes(study, lat)) return lat;
  }
  return 'left';
}

export function loadedPlanesForKnee(study: DicomStudy, laterality: Laterality): Plane[] {
  return (['axial', 'sagittal', 'coronal'] as Plane[]).filter((p) => volumeForKneePlane(study, laterality, p));
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
      const vol = volumeForKneePlane(study, laterality, plane);
      if (!vol) continue;
      rows.push({
        patientId: vol.patientId || study.patientId,
        laterality: lateralityForVolume(vol) ?? laterality,
        sequenceName: (vol.seriesDescription && vol.seriesDescription.trim()) || plane,
        plane,
      });
    }
  }
  return rows;
}
