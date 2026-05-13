import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MedicalImageViewer } from '@/app/components/MedicalImageViewer';
import type { Measurement } from '@/app/components/MedicalImageViewer';
import type { DicomStudy } from '@/app/components/dicom/DicomStudy';
import type { Plane } from '@/app/components/dicom/DicomLoader';
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
  exportSessionAnnotationsToCsv,
  isPlausibleEmail,
  sessionRowToMeasurement,
  type SessionAnnotationRow,
  type SessionAnnotator,
} from '@/app/lib/sessionAnnotationCsv';

interface PatientStudyRecord {
  key: string;
  study: DicomStudy;
  loadedAt: number;
}

const EMPTY_MEASUREMENTS: Measurement[] = [];

function mergeStudies(existing: DicomStudy, incoming: DicomStudy): DicomStudy {
  const volumes: DicomStudy['volumes'] = { ...existing.volumes };
  (['axial', 'sagittal', 'coronal'] as Plane[]).forEach((p) => {
    const next = incoming.volumes[p];
    if (!next) return;
    const prev = volumes[p];
    if (!prev || next.sliceCount >= prev.sliceCount) {
      volumes[p] = next;
    }
  });

  return {
    ...existing,
    studyName: incoming.studyName || existing.studyName,
    patientId: incoming.patientId || existing.patientId,
    patientName: incoming.patientName || existing.patientName,
    studyInstanceUID: incoming.studyInstanceUID || existing.studyInstanceUID,
    volumes,
  };
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
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    savePatientMeasurementArchive(measurementArchive);
  }, [measurementArchive]);

  const activeStudy = useMemo(
    () => patientStudies.find((p) => p.key === activePatientKey)?.study || null,
    [patientStudies, activePatientKey],
  );

  const activePatientMeasurements = useMemo((): Measurement[] => {
    if (!activePatientKey) return EMPTY_MEASUREMENTS;
    return measurementArchive[activePatientKey] ?? EMPTY_MEASUREMENTS;
  }, [measurementArchive, activePatientKey]);

  const activeSessionRowsForPatient = useMemo(() => {
    if (!annotator || !activePatientKey) return [];
    return sessionAnnotations.filter((r) => r.sourcePatientKey === activePatientKey);
  }, [annotator, activePatientKey, sessionAnnotations]);

  const measurementsForActivePatientViewer = useMemo((): Measurement[] => {
    if (!annotator || !activePatientKey) return EMPTY_MEASUREMENTS;
    return activeSessionRowsForPatient.map((r) => sessionRowToMeasurement(r) as Measurement);
  }, [annotator, activePatientKey, activeSessionRowsForPatient]);

  const patientLabelsForExport = useMemo(() => {
    const map: Record<string, { patientId?: string; patientName?: string }> = {};
    for (const r of patientStudies) {
      map[r.key] = { patientId: r.study.patientId, patientName: r.study.patientName };
    }
    return map;
  }, [patientStudies]);

  const updateActivePatientMeasurements = useCallback(
    (updater: (prev: Measurement[]) => Measurement[]) => {
      if (!activePatientKey) return;
      setMeasurementArchive((prev) => {
        const cur = prev[activePatientKey] ?? [];
        return { ...prev, [activePatientKey]: updater(cur) };
      });
    },
    [activePatientKey],
  );

  const deleteActivePatientMeasurement = useCallback(
    (id: string) => {
      if (!activePatientKey) return;
      setMeasurementArchive((prev) => ({
        ...prev,
        [activePatientKey]: (prev[activePatientKey] ?? []).filter((m) => m.id !== id),
      }));
    },
    [activePatientKey],
  );

  const commitSessionAnnotation = useCallback((row: SessionAnnotationRow) => {
    setSessionAnnotations((prev) => [...prev, row]);
  }, []);

  const deleteSessionAnnotation = useCallback((annotationId: string) => {
    setSessionAnnotations((prev) => prev.filter((r) => r.annotationId !== annotationId));
  }, []);

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
    if (sessionAnnotations.length === 0) {
      alert('No session measurements to export yet.');
      return;
    }
    const csv = exportSessionAnnotationsToCsv(sessionAnnotations);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadCsvFile(`mri-session-measurements-${stamp}.csv`, csv);
  }, [sessionAnnotations]);

  const handleFileLoad = (data: ArrayBuffer, name: string) => {
    setNiftiData(data);
    setActivePatientKey(null);
    setFileName(name);
  };

  const patientStudiesRef = useRef(patientStudies);
  patientStudiesRef.current = patientStudies;

  const handleStudyLoad = (study: DicomStudy) => {
    const uid = study.studyInstanceUID?.trim();
    const baseKey =
      uid ||
      `${study.patientId || 'unknown'}::${(study.studyName || 'Study').replace(/[|]+/g, '_')}`;
    const prev = patientStudiesRef.current;
    let key = baseKey;
    if (!uid && prev.some((r) => r.key === key)) {
      key = `${baseKey}__${Date.now()}`;
    }
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
    setActivePatientKey(key);
    setNiftiData(null);
    setFileName(`${study.patientId || 'unknown'} - ${study.studyName}`);
  };

  const exportActivePatientTsv = () => {
    if (!activePatientKey) return;
    const study = activeStudy;
    const tsv = exportPatientToTsv(activePatientKey, activePatientMeasurements, study?.patientId);
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
    const tsv = exportPatientToTsv(activePatientKey, activePatientMeasurements, study?.patientId);
    try {
      await navigator.clipboard.writeText(tsv);
      alert('TSV copied to clipboard — paste into a spreadsheet.');
    } catch {
      alert('Clipboard not available; use Export instead.');
    }
  };

  return (
    <div className="h-screen w-screen bg-gray-950 flex flex-col overflow-hidden">
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
          <div>
            <h2 className="text-sm font-semibold text-gray-200 mb-2">Patients</h2>
            {patientStudies.length === 0 ? (
              <p className="text-xs text-gray-500">No DICOM patients loaded yet.</p>
            ) : (
              <div className="space-y-2">
                {patientStudies
                  .slice()
                  .sort((a, b) => b.loadedAt - a.loadedAt)
                  .map(({ key, study }) => {
                    const loadedPlanes = (['axial', 'sagittal', 'coronal'] as Plane[]).filter((p) => study.volumes[p]);
                    const active = activePatientKey === key;
                    const count = annotator
                      ? sessionAnnotations.filter((r) => r.sourcePatientKey === key).length
                      : measurementArchive[key]?.length ?? 0;
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
                            className="flex-1 min-w-0 text-left px-2 py-2 hover:bg-gray-700/50 rounded-r"
                            onClick={() => {
                              setActivePatientKey(key);
                              setNiftiData(null);
                            }}
                          >
                            <div className="text-xs font-semibold truncate">{study.patientId || 'unknown-patient'}</div>
                            <div className="text-[11px] text-gray-300 truncate">{study.patientName || 'Unknown Patient'}</div>
                            <div className="text-[10px] text-gray-500 truncate">{study.studyName}</div>
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
                              <span className="text-gray-500 font-medium text-gray-400">Planes / sequences</span>
                              <ul className="mt-1 space-y-0.5">
                                {loadedPlanes.length === 0 ? (
                                  <li className="italic">No volumes</li>
                                ) : (
                                  loadedPlanes.map((p) => {
                                    const v = study.volumes[p];
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
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          {activePatientKey && (
            <div className="border-t border-gray-800 pt-3 flex flex-col gap-2 min-h-0 flex-1">
              <h3 className="text-xs font-semibold text-gray-300">Measurements (this patient)</h3>
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
                    Export session (CSV)
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
                        className="rounded border border-gray-700 bg-gray-800/80 px-2 py-1.5 text-gray-200"
                      >
                        <div className="flex justify-between gap-1 items-start">
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-gray-100 capitalize">{r.measurementType}</div>
                            <div className="text-gray-400">
                              {r.sequenceName} · {r.plane} · slice {r.sliceIndex}
                            </div>
                            {(r.value || r.units) && (
                              <div className="text-blue-300 mt-0.5">
                                {r.value}
                                {r.units ? ` ${r.units}` : ''}
                              </div>
                            )}
                            <div className="text-[10px] text-gray-500 mt-0.5">
                              {r.timestamp ? new Date(r.timestamp).toLocaleString() : '—'}
                            </div>
                            <div className="text-[9px] text-gray-600 font-mono truncate" title={r.annotationId}>
                              {r.annotatedBy} · {r.annotatorEmail}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="shrink-0 text-[10px] text-red-400 hover:text-red-300"
                            onClick={() => deleteSidebarMeasurement(r.annotationId)}
                            aria-label={`Delete measurement ${r.annotationId}`}
                          >
                            ×
                          </button>
                        </div>
                      </li>
                    ))
                  )
                ) : activePatientMeasurements.length === 0 ? (
                  <li className="text-gray-500 italic">No measurements yet for this patient.</li>
                ) : (
                  activePatientMeasurements.map((m) => (
                    <li
                      key={m.id}
                      className="rounded border border-gray-700 bg-gray-800/80 px-2 py-1.5 text-gray-200"
                    >
                      <div className="flex justify-between gap-1 items-start">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-gray-100 capitalize">{m.type}</div>
                          <div className="text-gray-400">
                            {m.plane} · slice index {m.slice}
                          </div>
                          {m.value ? <div className="text-blue-300 mt-0.5">{m.value}</div> : null}
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
                          onClick={() => deleteSidebarMeasurement(m.id)}
                          aria-label={`Delete measurement ${m.id}`}
                        >
                          ×
                        </button>
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
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
          />
        </div>
      </main>
    </div>
  );
}

export default App;
