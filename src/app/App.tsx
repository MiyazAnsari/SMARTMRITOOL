import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MedicalImageViewer } from '@/app/components/MedicalImageViewer';
import type { Measurement } from '@/app/components/MedicalImageViewer';
import { Button } from '@/app/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/app/components/ui/collapsible';
import { mergeStudies, type DicomStudy } from '@/app/components/dicom/DicomStudy';
import type { Plane } from '@/app/components/dicom/DicomLoader';
import type { Laterality } from '@/app/components/dicom/laterality';
import { LATERALITIES, measurementStorageKey } from '@/app/components/dicom/laterality';
import {
  firstAvailableLaterality,
  kneeHasVolumes,
  loadedPlanesForKnee,
  sequenceVolumeForKnee,
  studyViewForLaterality,
} from '@/app/components/dicom/patientStudy';
import {
  downloadTextFile,
  exportArchiveToTsv,
  exportPatientToTsv,
  loadPatientMeasurementArchive,
  mergeTsvIntoArchive,
  savePatientMeasurementArchive,
  type PatientMeasurementArchive,
} from '@/app/lib/patientMeasurementStorage';
import {
  downloadCsvFile,
  isPlausibleEmail,
  splitValueUnits,
  sessionRowToMeasurement,
  type SessionAnnotationRow,
  type SessionAnnotator,
} from '@/app/lib/sessionAnnotationCsv';
import { exportProtocolMeasurementsToCsv } from '@/app/lib/protocolMeasurementCsv';
import { HipXrayViewer } from '@/app/components/hip/HipXrayViewer';

type AppMode = 'select' | 'knee-mri' | 'hip-xray';

/** Compute the image-pixel distance for a distance/line/perpendicular measurement. */
function computePxDistance(
  points: { x: number; y: number }[],
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number } | null,
): string | null {
  if (points.length < 2) return null;
  const sx = imageScale?.x ?? 1;
  const sy = imageScale?.y ?? 1;
  const dx = points[1].x - points[0].x;
  const dy = points[1].y - points[0].y;
  const px = Math.hypot(dx * sx, dy * sy);
  if (!Number.isFinite(px) || px === 0) return null;
  return `${px.toFixed(1)} px`;
}

/** Compute mm distance from points + imageScale + pixel spacing. */
function computeMmValue(
  points: { x: number; y: number }[],
  imageScale?: { x: number; y: number; offsetX?: number; offsetY?: number } | null,
  spacing?: { x: number; y: number } | null,
): string | null {
  if (points.length < 2) return null;
  const sx = (imageScale?.x ?? 1) * (spacing?.x ?? 1);
  const sy = (imageScale?.y ?? 1) * (spacing?.y ?? 1);
  const dx = points[1].x - points[0].x;
  const dy = points[1].y - points[0].y;
  const mm = Math.hypot(dx * sx, dy * sy);
  if (!Number.isFinite(mm) || mm === 0) return null;
  return `${mm.toFixed(2)} mm`;
}

interface PatientStudyRecord {
  key: string;
  study: DicomStudy;
  loadedAt: number;
}

const EMPTY_MEASUREMENTS: Measurement[] = [];

function KneeLateralityToggle({
  value,
  onChange,
  study,
}: {
  value: Laterality;
  onChange: (lat: Laterality) => void;
  study: DicomStudy;
}) {
  return (
    <div className="flex gap-1 rounded-md bg-gray-950/80 p-0.5 border border-gray-700">
      {LATERALITIES.map((lat) => {
        const loaded = kneeHasVolumes(study, lat);
        const active = value === lat;
        return (
          <button
            key={lat}
            type="button"
            disabled={!loaded}
            onClick={() => onChange(lat)}
            className={`flex-1 rounded px-2 py-1 text-[10px] font-medium transition-colors ${
              active
                ? 'bg-blue-600 text-white'
                : loaded
                  ? 'text-gray-200 hover:bg-gray-700/80'
                  : 'text-gray-600 cursor-not-allowed'
            }`}
          >
            {lat === 'left' ? 'Left Knee' : 'Right Knee'}
          </button>
        );
      })}
    </div>
  );
}

function AnnotatorSessionModal({
  open,
  onSubmit,
}: {
  open: boolean;
  onSubmit: (annotator: SessionAnnotator) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');

  if (!open) return null;

  const submit = () => {
    if (!name.trim()) {
      setErr('Please enter your name.');
      return;
    }
    if (!isPlausibleEmail(email)) {
      setErr('Please enter a valid email address.');
      return;
    }
    setErr('');
    onSubmit({ name: name.trim(), email: email.trim() });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4">
      <div
        className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-4 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="annotator-session-title"
      >
        <h2 id="annotator-session-title" className="text-sm font-semibold text-gray-100">
          Annotator session
        </h2>
        <p className="mt-1 text-xs text-gray-400 leading-relaxed">
          Enter your name and email before annotating. This information is kept for this browser tab only and is included
          with each measurement. It is not written to disk as profile data.
        </p>
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="text-[11px] text-gray-400">Name</span>
            <input
              className="mt-0.5 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-gray-400">Email</span>
            <input
              type="email"
              className="mt-0.5 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
        </div>
        {err ? <p className="mt-2 text-xs text-red-400">{err}</p> : null}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
            onClick={submit}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [niftiData, setNiftiData] = useState<ArrayBuffer | null>(null);
  const [appMode, setAppMode] = useState<AppMode>('select');
  const [patientStudies, setPatientStudies] = useState<PatientStudyRecord[]>([]);
  const [activePatientKey, setActivePatientKey] = useState<string | null>(null);
  const [, setFileName] = useState<string>('');
  const [measurementArchive, setMeasurementArchive] = useState<PatientMeasurementArchive>(() =>
    loadPatientMeasurementArchive(),
  );
  /** Session-only: cleared when the tab is closed or the page is refreshed. */
  const [annotator, setAnnotator] = useState<SessionAnnotator | null>(null);
  const [sessionAnnotations, setSessionAnnotations] = useState<SessionAnnotationRow[]>([]);
  const [expandedPatientKeys, setExpandedPatientKeys] = useState<Record<string, boolean>>({});
  const [activeLateralityByPatient, setActiveLateralityByPatient] = useState<Record<string, Laterality>>({});
  const [patientsPanelOpen, setPatientsPanelOpen] = useState(true);
  const [measurementsPanelOpen, setMeasurementsPanelOpen] = useState(true);
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  const [forceJumpOnSelectId, setForceJumpOnSelectId] = useState<string | null>(null);
  const [currentProtocolGroupId, setCurrentProtocolGroupId] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const handleMeasurementSelect = useCallback(
    (id: string | null) => {
      setSelectedMeasurementId(id);
      if (id && forceJumpOnSelectId === id) {
        setForceJumpOnSelectId(null);
      }
    },
    [forceJumpOnSelectId],
  );

  useEffect(() => {
    savePatientMeasurementArchive(measurementArchive);
  }, [measurementArchive]);

  const activePatientRecord = useMemo(
    () => patientStudies.find((p) => p.key === activePatientKey) ?? null,
    [patientStudies, activePatientKey],
  );

  const activeLaterality = useMemo((): Laterality => {
    if (!activePatientKey || !activePatientRecord) return 'left';
    return (
      activeLateralityByPatient[activePatientKey] ??
      firstAvailableLaterality(activePatientRecord.study)
    );
  }, [activePatientKey, activePatientRecord, activeLateralityByPatient]);

  const activeStudy = useMemo(() => {
    if (!activePatientRecord) return null;
    return studyViewForLaterality(activePatientRecord.study, activeLaterality);
  }, [activePatientRecord, activeLaterality]);

  const activePixelSpacing = useMemo(() => {
    if (!activeStudy) return null;
    // Use the first available plane's pixel spacing.
    const vol = activeStudy.volumes.axial ?? activeStudy.volumes.sagittal ?? activeStudy.volumes.coronal;
    if (!vol?.header?.pixDims) return null;
    const pd = vol.header.pixDims;
    return { x: Number.isFinite(pd[1]) && pd[1] > 0 ? pd[1] : 1, y: Number.isFinite(pd[2]) && pd[2] > 0 ? pd[2] : 1 };
  }, [activeStudy]);

  const activeMeasurementKey = useMemo(() => {
    if (!activePatientKey) return null;
    return measurementStorageKey(activePatientKey, activeLaterality);
  }, [activePatientKey, activeLaterality]);

  const activePatientMeasurements = useMemo((): Measurement[] => {
    if (!activeMeasurementKey) return EMPTY_MEASUREMENTS;
    return measurementArchive[activeMeasurementKey] ?? EMPTY_MEASUREMENTS;
  }, [measurementArchive, activeMeasurementKey]);

  const activeSessionRowsForPatient = useMemo(() => {
    if (!annotator || !activePatientKey) return [];
    return sessionAnnotations.filter(
      (r) => r.sourcePatientKey === activePatientKey && r.laterality === activeLaterality,
    );
  }, [annotator, activePatientKey, activeLaterality, sessionAnnotations]);

  const measurementsForActivePatientViewer = useMemo((): Measurement[] => {
    if (!annotator || !activePatientKey) return EMPTY_MEASUREMENTS;
    return activeSessionRowsForPatient.map((r) => sessionRowToMeasurement(r) as Measurement);
  }, [annotator, activePatientKey, activeSessionRowsForPatient]);

  const groupedActiveMeasurements = useMemo(() => {
    const source = annotator ? measurementsForActivePatientViewer : activePatientMeasurements;
    const labels: Record<string, string> = {
      line: 'Lines',
      distance: 'Distances',
      angle: 'Angles',
      point: 'Points',
      perpendicular: 'Perpendiculars',
      ellipse: 'Ellipses',
      freehand: 'Freehand',
      closedCurve: 'Closed Curves',
      pan: 'Pan',
      none: 'Other',
    };
    const order: Measurement['type'][] = [
      'line',
      'distance',
      'perpendicular',
      'angle',
      'point',
      'ellipse',
      'freehand',
      'closedCurve',
    ];
    const map = new Map<string, Map<string, Measurement[]>>();
    source.forEach((m) => {
      const typeKey = m.type;
      const stepKey = m.workflowStepId || m.groupId || m.label || m.id;
      if (!map.has(typeKey)) map.set(typeKey, new Map());
      const byStep = map.get(typeKey)!;
      if (!byStep.has(stepKey)) byStep.set(stepKey, []);
      byStep.get(stepKey)!.push(m);
    });
    return order
      .filter((t) => map.has(t))
      .map((t) => ({
        key: t,
        label: labels[t] || t,
        groups: Array.from(map.get(t)!.entries()).map(([key, items]) => ({
          key,
          label: items[0]?.label || labels[t] || t,
          items,
        })),
      }));
  }, [annotator, measurementsForActivePatientViewer, activePatientMeasurements]);

  useEffect(() => {
    const source = annotator ? measurementsForActivePatientViewer : activePatientMeasurements;
    if (selectedMeasurementId && !source.some((m) => m.id === selectedMeasurementId)) {
      setSelectedMeasurementId(null);
    }
  }, [annotator, measurementsForActivePatientViewer, activePatientMeasurements, selectedMeasurementId]);

  const patientLabelsForExport = useMemo(() => {
    const map: Record<string, { patientId?: string; patientName?: string }> = {};
    for (const r of patientStudies) {
      map[r.key] = { patientId: r.study.patientId, patientName: r.study.patientName };
    }
    return map;
  }, [patientStudies]);

  const updateActivePatientMeasurements = useCallback(
    (updater: (prev: Measurement[]) => Measurement[]) => {
      if (!activeMeasurementKey) return;
      setMeasurementArchive((prev) => {
        const cur = prev[activeMeasurementKey] ?? [];
        return { ...prev, [activeMeasurementKey]: updater(cur) };
      });
    },
    [activeMeasurementKey],
  );

  const deleteActivePatientMeasurement = useCallback(
    (id: string) => {
      if (!activeMeasurementKey) return;
      setMeasurementArchive((prev) => ({
        ...prev,
        [activeMeasurementKey]: (prev[activeMeasurementKey] ?? []).filter((m) => m.id !== id),
      }));
    },
    [activeMeasurementKey],
  );

  const commitSessionAnnotation = useCallback((row: SessionAnnotationRow) => {
    setSessionAnnotations((prev) => [...prev, row]);
  }, []);

  const deleteSessionAnnotation = useCallback((annotationId: string) => {
    setSessionAnnotations((prev) => prev.filter((r) => r.annotationId !== annotationId && r.baseLineId !== annotationId));
  }, []);

  const removePatient = useCallback((key: string) => {
    setMeasurementArchive((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (k.startsWith(key + '::') || k === key) delete next[k];
      }
      return next;
    });
    setSessionAnnotations((prev) => prev.filter((r) => r.sourcePatientKey !== key));
    setActiveLateralityByPatient((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setPatientStudies((prev) => {
      const remaining = prev.filter((p) => p.key !== key);
      if (activePatientKey === key) {
        // Switch to another patient so the viewport doesn't stay on the removed one
        if (remaining.length > 0) {
          const removedIdx = prev.findIndex((p) => p.key === key);
          const nextIdx = Math.min(removedIdx, remaining.length - 1);
          setActivePatientKey(remaining[nextIdx].key);
        } else {
          setActivePatientKey(null);
        }
      }
      return remaining;
    });
  }, [activePatientKey]);

  const updateSessionAnnotation = useCallback(
    (annotationId: string, updater: (row: SessionAnnotationRow) => SessionAnnotationRow) => {
      setSessionAnnotations((prev) => {
        const next = prev.map((row) => (row.annotationId === annotationId ? updater(row) : row));
        const updatedRow = next.find((row) => row.annotationId === annotationId);
        if (!updatedRow) return next;

        const valueText = updatedRow.value && updatedRow.units ? `${updatedRow.value} ${updatedRow.units}` : updatedRow.value || updatedRow.units;
        const targetLength = valueText ? Math.hypot(0, 0) : null;
        void targetLength;

        const reprojectPerpendicular = (row: SessionAnnotationRow, baseline: SessionAnnotationRow): SessionAnnotationRow => {
          if (!row.baseLineId || row.baseLineId !== baseline.annotationId || row.points.length < 2 || baseline.points.length < 2) {
            return row;
          }

          const p0 = baseline.points[0];
          const p1 = baseline.points[1];
          const dx = p1.x - p0.x;
          const dy = p1.y - p0.y;
          const len = Math.hypot(dx, dy);
          if (len === 0) return row;

          const lineX = dx / len;
          const lineY = dy / len;
          const perpX = -dy / len;
          const perpY = dx / len;

          const oldAnchor = row.points[0];
          const t = Math.max(0, Math.min(1, ((oldAnchor.x - p0.x) * lineX + (oldAnchor.y - p0.y) * lineY) / len));
          const anchorX = p0.x + lineX * t * len;
          const anchorY = p0.y + lineY * t * len;

          const stubDx = row.points[1].x - row.points[0].x;
          const stubDy = row.points[1].y - row.points[0].y;
          const stubLen = Math.hypot(stubDx, stubDy) || 1;
          const sign = stubDx * perpX + stubDy * perpY >= 0 ? 1 : -1;

          return {
            ...row,
            points: [
              { x: anchorX, y: anchorY },
              { x: anchorX + perpX * stubLen * sign, y: anchorY + perpY * stubLen * sign },
            ],
          };
        };

        const updatedType = updatedRow.measurementType;
        if (updatedType === 'distance' || updatedType === 'line') {
          return next.map((row) => {
            if (row.baseLineId !== updatedRow.annotationId) return row;
            return reprojectPerpendicular(row, updatedRow);
          });
        }

        if (updatedType === 'perpendicular' && updatedRow.baseLineId) {
          const baseline = next.find((row) => row.annotationId === updatedRow.baseLineId);
          if (baseline) {
            return next.map((row) => (row.annotationId === annotationId ? reprojectPerpendicular(row, baseline) : row));
          }
        }

        return next;
      });
    },
    [],
  );

  const deleteSidebarMeasurement = useCallback(
    (id: string) => {
      if (annotator) {
        deleteSessionAnnotation(id);
        return;
      }
      deleteActivePatientMeasurement(id);
    },
    [annotator, deleteSessionAnnotation, deleteActivePatientMeasurement],
  );

  const exportSessionMeasurementsCsv = useCallback(() => {
    const sourceRows = annotator ? sessionAnnotations : activePatientMeasurements;
    if (sourceRows.length === 0) {
      alert('No measurements to export yet.');
      return;
    }
    const csv = exportProtocolMeasurementsToCsv(
      annotator
        ? sessionAnnotations.map((row) => ({
            ...sessionRowToMeasurement(row),
            patientId: row.patientId,
            laterality: row.laterality,
          }))
        : activePatientMeasurements,
      {
        study: activeStudy,
        patientId: activeStudy?.patientId || activePatientKey || undefined,
        sessionUser: annotator?.name || undefined,
        sessionUserEmail: annotator?.email || undefined,
        laterality: activeStudy?.laterality || undefined,
        sequenceName: undefined,
      },
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadCsvFile(`mri-protocol-measurements-${stamp}.csv`, csv);
  }, [annotator, sessionAnnotations, activePatientMeasurements, activeStudy, activePatientKey]);

  const handleFileLoad = (data: ArrayBuffer, name: string) => {
    setNiftiData(data);
    setActivePatientKey(null);
    setFileName(name);
  };

  const patientStudiesRef = useRef(patientStudies);
  patientStudiesRef.current = patientStudies;

  const handleStudyLoad = (study: DicomStudy) => {
    const uid = study.studyInstanceUID?.trim();
    const prev = patientStudiesRef.current;

    // Determine whether this study carries a real (non-placeholder) patient id.
    const realPatientId =
      study.patientId &&
      study.patientId !== 'unknown' &&
      !study.patientId.startsWith('unknown-')
        ? study.patientId
        : null;

    // ---- resolve the merge key -------------------------------------------
    // Priority:
    //  1. Same StudyInstanceUID (most reliable)
    //  2. Same real PatientID — merges bilateral studies for the same patient
    //     whether they were selected together or loaded separately.
    //  3. Fallback: patientId::studyName
    let existingKey: string | undefined;

    if (uid) {
      existingKey = prev.find((r) => r.study.studyInstanceUID === uid)?.key;
    }
    if (!existingKey && realPatientId) {
      existingKey = prev.find(
        (r) => r.study.patientId === realPatientId,
      )?.key;
    }

    let key: string;
    if (existingKey) {
      key = existingKey;
    } else if (uid) {
      key = uid;
    } else {
      key = `${study.patientId || 'unknown'}::${(study.studyName || 'Study').replace(/[|]+/g, '_')}`;
      if (prev.some((r) => r.key === key)) {
        key = `${key}__${Date.now()}`;
      }
    }

    const loadedKnee = firstAvailableLaterality(study);
    setPatientStudies((p) => {
      const idx = p.findIndex((r) => r.key === key);
      if (idx < 0) {
        return [...p, { key, study, loadedAt: Date.now() }];
      }
      const next = [...p];
      next[idx] = {
        ...next[idx],
        loadedAt: Date.now(),
        study: mergeStudies(next[idx].study, study),
      };
      return next;
    });
    setActiveLateralityByPatient((m) => ({ ...m, [key]: loadedKnee }));
    setActivePatientKey(key);
    setNiftiData(null);
    setFileName(`${study.patientId || 'unknown'} - ${study.studyName}`);
  };

  const exportActivePatientTsv = () => {
    if (!activePatientKey) return;
    const study = activeStudy;
    const tsv = exportPatientToTsv(
      activeMeasurementKey ?? activePatientKey,
      activePatientMeasurements,
      study?.patientId,
    );
    const safe = (study?.patientId || activePatientKey).replace(/[^\w.-]+/g, '_');
    downloadTextFile(`measurements-${safe}.tsv`, tsv);
  };

  const exportAllPatientsTsv = () => {
    const tsv = exportArchiveToTsv(measurementArchive, patientLabelsForExport);
    downloadTextFile('all-patient-measurements.tsv', tsv);
  };

  const onPickImportFile = () => importInputRef.current?.click();

  const onImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const { archive, errors, importedCount } = mergeTsvIntoArchive(text, measurementArchive);
      setMeasurementArchive(archive);
      if (errors.length) {
        console.warn('Measurement import warnings:', errors);
      }
      if (importedCount > 0 || errors.length) {
        const msg = [
          `Imported or updated ${importedCount} row(s).`,
          errors.length ? `${errors.length} issue(s) — see console.` : '',
        ]
          .filter(Boolean)
          .join(' ');
        alert(msg);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const copyActivePatientTsv = async () => {
    if (!activePatientKey) return;
    const study = activeStudy;
    const tsv = exportPatientToTsv(
      activeMeasurementKey ?? activePatientKey,
      activePatientMeasurements,
      study?.patientId,
    );
    try {
      await navigator.clipboard.writeText(tsv);
      alert('TSV copied to clipboard — paste into a spreadsheet.');
    } catch {
      alert('Clipboard not available; use Export instead.');
    }
  };

  // ── Mode Selection Screen ────────────────────────────────────────────
  if (appMode === 'select') {
    return (
      <div className="h-screen w-screen bg-gray-950 flex flex-col items-center justify-center overflow-hidden">
        <div className="text-center max-w-lg px-6">
          <h1 className="text-3xl font-bold text-white mb-2">Medical Image Viewer</h1>
          <p className="text-gray-400 text-sm mb-10">
            Select an imaging modality to begin measurements.
          </p>
          <div className="grid grid-cols-1 gap-5">
            <button
              type="button"
              onClick={() => setAppMode('knee-mri')}
              className="group relative rounded-xl border-2 border-blue-800 bg-blue-950/40 p-8 text-left transition-all hover:border-blue-500 hover:bg-blue-900/40 hover:shadow-lg hover:shadow-blue-900/30"
            >
              <div className="text-lg font-bold text-blue-200 group-hover:text-blue-100 mb-2">
                🦵 Knee MRIs
              </div>
              <div className="text-sm text-blue-400/80 group-hover:text-blue-300 leading-relaxed">
                Multi-planar DICOM studies. Load axial, sagittal, and coronal sequences per knee.
                TT-TG, Insall–Salvati, and patellar tilt measurement protocols.
              </div>
              <div className="mt-3 text-xs text-blue-500/60 group-hover:text-blue-400">
                Supports NIfTI and DICOM folders →
              </div>
            </button>
            <button
              type="button"
              onClick={() => setAppMode('hip-xray')}
              className="group relative rounded-xl border-2 border-emerald-800 bg-emerald-950/40 p-8 text-left transition-all hover:border-emerald-500 hover:bg-emerald-900/40 hover:shadow-lg hover:shadow-emerald-900/30"
            >
              <div className="text-lg font-bold text-emerald-200 group-hover:text-emerald-100 mb-2">
                🦴 Hip X-rays
              </div>
              <div className="text-sm text-emerald-400/80 group-hover:text-emerald-300 leading-relaxed">
                AP Pelvis computed radiography. Single coronal image per patient with bilateral hip assessment.
                10-measurement protocol: cortical thickness, neck width, head diameter, axis lengths, offsets, and neck angle.
              </div>
              <div className="mt-3 text-xs text-emerald-500/60 group-hover:text-emerald-400">
                Load a folder of .dcm files (one per patient) →
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Hip X-ray Mode ───────────────────────────────────────────────────
  if (appMode === 'hip-xray') {
    return (
      <div className="h-screen w-screen bg-gray-950 flex flex-col overflow-hidden">
        <AnnotatorSessionModal open={annotator === null} onSubmit={setAnnotator} />
        {/* Top bar with back button */}
        <header className="h-10 border-b border-gray-800 bg-gray-900 flex items-center justify-between px-3 shrink-0">
          <button
            type="button"
            onClick={() => setAppMode('select')}
            className="text-xs text-gray-400 hover:text-gray-200 transition-colors flex items-center gap-1"
          >
            ← Back to mode selection
          </button>
          <span className="text-xs text-gray-500">Hip X-ray Measurement Mode</span>
          <div className="w-20" /> {/* spacer */}
        </header>
        <div className="flex-1 min-h-0">
          <HipXrayViewer
            sessionUser={annotator?.name}
            sessionUserEmail={annotator?.email}
          />
        </div>
      </div>
    );
  }

  // ── Knee MRI Mode (existing) ─────────────────────────────────────────
  return (
    <div className="h-screen w-screen bg-gray-950 flex flex-col overflow-hidden">
      {/* Top bar with back button */}
      <header className="h-10 border-b border-gray-800 bg-gray-900 flex items-center justify-between px-3 shrink-0">
        <button
          type="button"
          onClick={() => setAppMode('select')}
          className="text-xs text-gray-400 hover:text-gray-200 transition-colors flex items-center gap-1"
        >
          ← Back to mode selection
        </button>
        <span className="text-xs text-gray-500">Knee MRI Measurement Mode</span>
        <div className="w-20" /> {/* spacer */}
      </header>
      <AnnotatorSessionModal open={annotator === null} onSubmit={setAnnotator} />
      <main className="flex-1 overflow-hidden flex min-h-0">
        <aside className="w-72 border-r border-gray-800 bg-gray-900 p-3 overflow-y-auto flex flex-col gap-3 shrink-0">
          {annotator ? (
            <div className="rounded border border-gray-700 bg-gray-800/60 px-2 py-1.5 text-[10px] text-gray-300">
              <div className="font-medium text-gray-100">Session annotator</div>
              <div className="truncate">{annotator.name}</div>
              <div className="truncate text-gray-400">{annotator.email}</div>
            </div>
          ) : null}
          <Collapsible open={patientsPanelOpen} onOpenChange={setPatientsPanelOpen} className="rounded border border-gray-800 bg-gray-900/60">
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-200">Patients</h2>
              <CollapsibleTrigger asChild>
                <button type="button" className="text-[10px] text-gray-400 hover:text-gray-200">
                  {patientsPanelOpen ? 'Collapse' : 'Expand'}
                </button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent className="p-3">
                <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
              {patientStudies.length === 0 ? (
                <p className="text-xs text-gray-500">No DICOM patients loaded yet.</p>
              ) : (
                <div className="space-y-2">
                  {patientStudies
                    .slice()
                    .sort((a, b) => b.loadedAt - a.loadedAt)
                    .map(({ key, study }) => {
                      const active = activePatientKey === key;
                      const kneeLat = active
                        ? activeLaterality
                        : activeLateralityByPatient[key] ?? firstAvailableLaterality(study);
                      const loadedPlanes = loadedPlanesForKnee(study, kneeLat);
                      const count = annotator
                        ? sessionAnnotations.filter((r) => r.sourcePatientKey === key).length
                        : LATERALITIES.reduce(
                            (n, lat) =>
                              n + (measurementArchive[measurementStorageKey(key, lat)]?.length ?? 0),
                            0,
                          );
                      const expanded = Boolean(expandedPatientKeys[key]);
                      return (
                        <div
                          key={key}
                          className={`rounded border text-left ${
                            active ? 'border-blue-500 bg-blue-900/30' : 'border-gray-700 bg-gray-800/80'
                          }`}
                        >
                          <div className="flex items-stretch gap-0">
                            <button
                              type="button"
                              className="shrink-0 px-1.5 text-[10px] text-gray-400 hover:text-gray-200 border-r border-gray-700/80"
                              aria-expanded={expanded}
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedPatientKeys((m) => ({ ...m, [key]: !expanded }));
                              }}
                              title={expanded ? 'Collapse' : 'Expand'}
                            >
                              {expanded ? '▼' : '▶'}
                            </button>
                            <button
                              type="button"
                              className="shrink-0 px-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30 border-r border-gray-700/80"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm('Remove patient ' + (study.patientId || 'unknown') + ' and all their measurements?')) {
                                  removePatient(key);
                                }
                              }}
                              title="Remove patient"
                            >
                              ×
                            </button>
                            <button
                              type="button"
                              className="flex-1 min-w-0 text-left px-2 py-2 hover:bg-gray-700/50 rounded-r"
                              onClick={() => {
                                setActivePatientKey(key);
                                setNiftiData(null);
                              }}
                            >
                              <div className="text-xs font-semibold truncate">{study.patientId || 'unknown-patient'}</div>
                              <div className="text-[11px] text-gray-300 truncate">{study.patientName || 'Unknown Patient'}</div>
                              <div className="text-[10px] text-gray-500 truncate">{study.studyName}</div>
                              <div className="text-[10px] text-gray-400 mt-0.5">
                                {LATERALITIES.filter((lat) => kneeHasVolumes(study, lat))
                                  .map((lat) => (lat === 'left' ? 'L' : 'R'))
                                  .join(' · ') || '—'}{' '}
                                knee
                              </div>
                              <div className="text-[10px] text-gray-400 mt-1">{count} measurement(s)</div>
                            </button>
                          </div>
                          {expanded ? (
                            <div className="border-t border-gray-700/80 px-2 py-2 text-[10px] text-gray-400 space-y-1.5 bg-gray-900/40">
                              <div>
                                <span className="text-gray-500">Key: </span>
                                <span className="font-mono text-gray-300 break-all">{key}</span>
                              </div>
                              <div>
                                <span className="text-gray-500">Study UID: </span>
                                <span className="text-gray-300">{study.studyInstanceUID || '—'}</span>
                              </div>
                              <div>
                                <span className="text-gray-500 font-medium text-gray-400">
                                  {active
                                    ? `${kneeLat === 'left' ? 'Left' : 'Right'} knee · sequences`
                                    : 'Knees / sequences'}
                                </span>
                                {active ? (
                                  <ul className="mt-1 space-y-0.5">
                                    {loadedPlanes.length === 0 ? (
                                      <li className="italic">No volumes for this knee</li>
                                    ) : (
                                      loadedPlanes.map((p) => {
                                        const v = sequenceVolumeForKnee(study, kneeLat, p);
                                        const desc = v?.seriesDescription?.trim();
                                        return (
                                          <li key={p} className="text-gray-300 capitalize">
                                            {p}
                                            {desc ? <span className="text-gray-500"> — {desc}</span> : null}
                                          </li>
                                        );
                                      })
                                    )}
                                  </ul>
                                ) : (
                                  <div className="mt-1 space-y-1.5">
                                    {LATERALITIES.map((lat) => {
                                      const planes = loadedPlanesForKnee(study, lat);
                                      return (
                                        <div key={lat}>
                                          <div className="text-gray-400 capitalize">
                                            {lat === 'left' ? 'Left' : 'Right'} knee
                                          </div>
                                          {planes.length === 0 ? (
                                            <div className="italic text-gray-500">No volumes</div>
                                          ) : (
                                            <ul className="space-y-0.5">
                                              {planes.map((p) => {
                                                const v = sequenceVolumeForKnee(study, lat, p);
                                                const desc = v?.seriesDescription?.trim();
                                                return (
                                                  <li key={p} className="text-gray-300 capitalize">
                                                    {p}
                                                    {desc ? (
                                                      <span className="text-gray-500"> — {desc}</span>
                                                    ) : null}
                                                  </li>
                                                );
                                              })}
                                            </ul>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible open={measurementsPanelOpen} onOpenChange={setMeasurementsPanelOpen} className="rounded border border-gray-800 bg-gray-900/60">
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-200">Measurements</h2>
              <CollapsibleTrigger asChild>
                <button type="button" className="text-[10px] text-gray-400 hover:text-gray-200">
                  {measurementsPanelOpen ? 'Collapse' : 'Expand'}
                </button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent className="p-3">
              {activePatientKey && activePatientRecord ? (
                <div className="flex flex-col gap-2 min-h-0">
              <div>
                <h3 className="text-xs font-semibold text-gray-300 mb-1.5">Knee</h3>
                <KneeLateralityToggle
                  value={activeLaterality}
                  onChange={(lat) =>
                    setActiveLateralityByPatient((m) => ({ ...m, [activePatientKey]: lat }))
                  }
                  study={activePatientRecord.study}
                />
              </div>
              <h3 className="text-xs font-semibold text-gray-300">
                Measurements ({activeLaterality} knee)
              </h3>
              <p className="text-[10px] text-gray-500">
                {annotator
                  ? 'Session list: kept until you close this tab. Separate from viewport pan/zoom/brightness.'
                  : 'Saved automatically. Updates as you draw in the viewer.'}
              </p>
              {annotator ? (
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    className="text-[10px] px-2 py-1 rounded bg-emerald-900/50 border border-emerald-700 text-emerald-100 hover:bg-emerald-900/70"
                    onClick={exportSessionMeasurementsCsv}
                  >
                    Export protocol CSV
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="text-[10px] px-2 py-1 rounded bg-gray-800 border border-gray-600 text-gray-200 hover:bg-gray-700"
                      onClick={exportActivePatientTsv}
                    >
                      Export TSV
                    </button>
                    <button
                      type="button"
                      className="text-[10px] px-2 py-1 rounded bg-gray-800 border border-gray-600 text-gray-200 hover:bg-gray-700"
                      onClick={copyActivePatientTsv}
                    >
                      Copy TSV
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="text-[10px] px-2 py-1 rounded bg-gray-800 border border-gray-600 text-gray-200 hover:bg-gray-700"
                      onClick={exportAllPatientsTsv}
                    >
                      Export all (TSV)
                    </button>
                    <button
                      type="button"
                      className="text-[10px] px-2 py-1 rounded bg-gray-800 border border-gray-600 text-gray-200 hover:bg-gray-700"
                      onClick={onPickImportFile}
                    >
                      Import TSV…
                    </button>
                    <input
                      ref={importInputRef}
                      type="file"
                      accept=".tsv,.txt,.csv,text/tab-separated-values,text/plain"
                      className="hidden"
                      onChange={onImportFileChange}
                    />
                  </div>
                </>
              )}
              <ul className="space-y-1.5 overflow-y-auto max-h-[40vh] pr-1 text-[11px]">
                {annotator ? (
                  activeSessionRowsForPatient.length === 0 ? (
                    <li className="text-gray-500 italic">No session measurements yet for this patient.</li>
                  ) : (
                    activeSessionRowsForPatient.map((r) => (
                      <li
                        key={r.annotationId}
                        className="rounded border border-gray-700 bg-gray-800/80 px-2 py-1.5 text-gray-200 hover:bg-gray-750 cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          setForceJumpOnSelectId(r.annotationId);
                          setSelectedMeasurementId(r.annotationId);
                        }}
                      >
                        <div className="flex justify-between gap-1 items-start">
                          <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1 flex-wrap">
                                <div className="font-medium text-gray-100 capitalize">{r.label || r.measurementType}</div>
                                {(() => {
                                  if (!r.groupId || !currentProtocolGroupId) return null;
                                  const protocolPrefix = currentProtocolGroupId.split('-').slice(0, -1).join('-');
                                  const belongsToActive = r.groupId === currentProtocolGroupId;
                                  return belongsToActive ? (
                                    <span
                                      title={`Active protocol group: ${protocolPrefix} (${r.groupId})`}
                                      aria-label={`Measurement belongs to active protocol group ${r.groupId}`}
                                      className="inline-block text-[10px] px-1 py-0.5 rounded bg-green-800 text-green-200 cursor-help"
                                    >
                                      group
                                    </span>
                                  ) : null;
                                })()}
                              </div>
                              <div className="text-[10px] text-blue-300 mt-0.5">
                                {r.workflowStepId || r.groupId || r.measurementType}
                              </div>
                            <div className="text-gray-400">
                              {r.laterality} knee · {r.sequenceName} · {r.plane} · slice {r.sliceIndex}
                            </div>
                            {computeMmValue(r.points, r.imageScale, activePixelSpacing) ? (
                              <div className="text-blue-300 mt-0.5 font-medium">
                                {computeMmValue(r.points, r.imageScale, activePixelSpacing)}
                              </div>
                            ) : (r.value || r.units) ? (
                              <div className="text-blue-300 mt-0.5">
                                {r.value}
                                {r.units ? ` ${r.units}` : ''}
                              </div>
                            ) : null}
                            {computePxDistance(r.points, r.imageScale) && (
                              <div className="text-emerald-300 text-[10px] font-mono mt-0.5">
                                {computePxDistance(r.points, r.imageScale)}
                              </div>
                            )}
                            <div className="text-[10px] text-gray-500 mt-0.5">
                              {r.timestamp ? new Date(r.timestamp).toLocaleString() : '—'}
                            </div>
                            <div className="text-[9px] text-gray-600 font-mono truncate" title={r.annotationId}>
                              {r.annotatedBy} · {r.annotatorEmail}
                            </div>
                          </div>
                          <div className="flex items-start gap-1">
                          <button
                            type="button"
                            className={`shrink-0 text-[10px] px-2 py-0.5 rounded border ${
                              selectedMeasurementId === r.annotationId
                                ? 'border-blue-500 bg-blue-900/50 text-blue-200 hover:bg-blue-800/60'
                                : 'border-gray-600 bg-gray-800 text-gray-200 hover:bg-gray-700'
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setForceJumpOnSelectId(r.annotationId);
                            }}
                            aria-label={`Select measurement ${r.annotationId}`}
                          >
                            {selectedMeasurementId === r.annotationId ? 'Selected' : 'Select'}
                          </button>
                          <button
                            type="button"
                            className="shrink-0 text-[10px] text-red-400 hover:text-red-300"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSidebarMeasurement(r.annotationId);
                            }}
                            aria-label={`Delete measurement ${r.annotationId}`}
                          >
                            ×
                          </button>
                            <button
                              type="button"
                              className="shrink-0 text-[10px] text-gray-300 hover:text-gray-200 ml-2"
                              onClick={(e) => {
                                e.stopPropagation();
                                const newLabel = prompt('Rename measurement', r.label || r.measurementType);
                                if (newLabel != null) {
                                  updateSessionAnnotation(r.annotationId, (row) => ({ ...row, label: newLabel }));
                                }
                              }}
                              aria-label={`Rename measurement ${r.annotationId}`}
                            >
                              ✎
                            </button>
                          <button
                            type="button"
                            className="shrink-0 text-[10px] text-gray-300 hover:text-gray-200"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateSessionAnnotation(r.annotationId, (row) => ({ ...row, propagateAcrossSlices: !row.propagateAcrossSlices }));
                            }}
                            aria-label={`Toggle propagate across slices for ${r.annotationId}`}
                          >
                            {r.propagateAcrossSlices === false ? 'Lock' : 'Prop'}
                          </button>
                          </div>
                        </div>
                      </li>
                    ))
                  )
                ) : activePatientMeasurements.length === 0 ? (
                  <li className="text-gray-500 italic">No measurements yet for this patient.</li>
                ) : (
                  groupedActiveMeasurements.map((group) => (
                    <li key={group.key} className="space-y-1">
                      <details open className="rounded border border-gray-800 bg-gray-950/40">
                        <summary className="cursor-pointer select-none list-none px-2 py-1.5 text-[10px] uppercase tracking-wide text-gray-400 font-semibold flex items-center justify-between">
                          <span>{group.label}</span>
                          <span className="text-gray-500 normal-case">{group.groups.length}</span>
                        </summary>
                        <div className="space-y-1 px-2 pb-2">
                          {group.groups.map((subgroup) => (
                            <details key={subgroup.key} open className="rounded border border-gray-800 bg-gray-900/60">
                              <summary className="cursor-pointer select-none list-none px-2 py-1 text-[10px] text-blue-200 font-medium flex items-center justify-between">
                                <span>{subgroup.label}</span>
                                <span className="text-gray-400 normal-case">{subgroup.items.length}</span>
                              </summary>
                              <ul className="space-y-1 px-2 pb-2">
                                {subgroup.items.map((m) => {
                                  const selected = selectedMeasurementId === m.id;
                                  return (
                                    <li
                                      key={m.id}
                                      className={`rounded border px-2 py-2 text-gray-200 cursor-pointer transition-colors ${
                                        selected
                                          ? 'border-blue-500 bg-blue-900/55 ring-1 ring-blue-400/70'
                                          : 'border-gray-700 bg-gray-800/80 hover:border-gray-500 hover:bg-gray-750'
                                      }`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setForceJumpOnSelectId(m.id);
                                        setSelectedMeasurementId(m.id);
                                      }}
                                    >
                                      <div className="flex justify-between gap-2 items-start">
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center justify-between gap-2">
                                            <div className={`font-semibold capitalize ${selected ? 'text-blue-100' : 'text-gray-100'}`}>{m.label || m.type}</div>
                                              {(() => {
                                                if (!m.groupId || !currentProtocolGroupId) return null;
                                                const protocolPrefix = currentProtocolGroupId.split('-').slice(0, -1).join('-');
                                                const belongsToActive = m.groupId === currentProtocolGroupId;
                                                return belongsToActive ? (
                                                  <span
                                                    title={`Active protocol group: ${protocolPrefix} (${m.groupId})`}
                                                    aria-label={`Measurement belongs to active protocol group ${m.groupId}`}
                                                    className="ml-2 inline-block text-[10px] px-1 py-0.5 rounded bg-green-800 text-green-200 cursor-help"
                                                  >
                                                    group
                                                  </span>
                                                ) : null;
                                              })()}
                                            <button
                                              type="button"
                                              className="ml-2 text-[10px] text-gray-300 hover:text-gray-200"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                const newLabel = prompt('Rename measurement', m.label || m.type);
                                                if (newLabel != null) {
                                                  updateActivePatientMeasurements((prev) => prev.map((mm) => (mm.id === m.id ? { ...mm, label: newLabel } : mm)));
                                                }
                                              }}
                                              aria-label={`Rename measurement ${m.id}`}
                                            >
                                              ✎
                                            </button>
                                          </div>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className={`mt-1 h-6 px-2 text-[10px] ${
                                              selected ? 'text-blue-200 hover:bg-blue-900/40' : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                                            }`}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              console.debug('[App] request force jump for', m.id);
                                              setForceJumpOnSelectId(m.id);
                                            }}
                                            aria-label={`Select measurement ${m.id}`}
                                          >
                                            {selected ? 'Selected' : 'Select'}
                                          </Button>
                                          <div className="text-[10px] text-blue-300 mt-0.5">
                                            {m.workflowStepId || m.groupId || group.label}
                                          </div>
                                          <div className="text-gray-400 mt-0.5">
                                            {m.plane} · slice index {m.slice}
                                          </div>
                                          {m.value ? <div className="text-blue-300 mt-1 font-medium">{m.value}</div> : null}
                                          {computeMmValue(m.points, m.imageScale, activePixelSpacing) ? (
                                            <div className="text-blue-300 mt-1 font-medium">
                                              {computeMmValue(m.points, m.imageScale, activePixelSpacing)}
                                            </div>
                                          ) : (
                                            m.value ? <div className="text-blue-300 mt-1 font-medium">{m.value}</div> : null
                                          )}
                                          {computePxDistance(m.points, m.imageScale) && (
                                            <div className="text-emerald-300 text-[10px] font-mono mt-0.5">
                                              {computePxDistance(m.points, m.imageScale)}
                                            </div>
                                          )}
                                          <div className="text-[10px] text-gray-500 mt-0.5">
                                            {m.timestamp ? new Date(m.timestamp).toLocaleString() : '—'}
                                          </div>
                                          <div className="text-[9px] text-gray-600 font-mono truncate" title={m.id}>
                                            id {m.id}
                                          </div>
                                        </div>
                                        <button
                                          type="button"
                                          className="shrink-0 text-[10px] text-red-400 hover:text-red-300"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            deleteSidebarMeasurement(m.id);
                                          }}
                                          aria-label={`Delete measurement ${m.id}`}
                                        >
                                          ×
                                        </button>
                                        <button
                                          type="button"
                                          className="shrink-0 text-[10px] text-gray-300 hover:text-gray-200 ml-1"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            updateActivePatientMeasurements((prev) =>
                                              prev.map((mm) => (mm.id === m.id ? { ...mm, propagateAcrossSlices: !(mm.propagateAcrossSlices ?? true) } : mm)),
                                            );
                                          }}
                                          aria-label={`Toggle propagate across slices for ${m.id}`}
                                        >
                                          {m.propagateAcrossSlices === false ? 'Lock' : 'Prop'}
                                        </button>
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            </details>
                          ))}
                        </div>
                      </details>
                    </li>
                  ))
                )}
              </ul>
                </div>
              ) : (
                <p className="text-xs text-gray-500">Select a patient to see measurements.</p>
              )}
            </CollapsibleContent>
          </Collapsible>
        </aside>
        <div className="flex-1 min-w-0 min-h-0">
          <MedicalImageViewer
            niftiData={niftiData}
            studyData={activeStudy}
            onFileLoad={handleFileLoad}
            onStudyLoad={handleStudyLoad}
            patientStorageKey={activePatientKey}
            patientMeasurements={
              activePatientKey && annotator
                ? measurementsForActivePatientViewer
                : activePatientKey
                  ? activePatientMeasurements
                  : undefined
            }
            onPatientMeasurementsUpdate={
              activePatientKey && annotator ? undefined : activePatientKey ? updateActivePatientMeasurements : undefined
            }
            sessionAnnotator={annotator}
            onCommitSessionAnnotation={activePatientKey && annotator ? commitSessionAnnotation : undefined}
            onDeleteSessionAnnotation={activePatientKey && annotator ? deleteSessionAnnotation : undefined}
            onUpdateSessionAnnotation={activePatientKey && annotator ? updateSessionAnnotation : undefined}
            selectedMeasurementId={selectedMeasurementId}
            onMeasurementSelect={handleMeasurementSelect}
            forceJumpOnSelectId={forceJumpOnSelectId}
            onCurrentGroupChange={setCurrentProtocolGroupId}
          />
        </div>
      </main>
    </div>
  );
}

export default App;