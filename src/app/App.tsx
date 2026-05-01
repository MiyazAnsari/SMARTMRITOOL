import { useMemo, useState } from 'react';
import { MedicalImageViewer } from '@/app/components/MedicalImageViewer';
import type { DicomStudy } from '@/app/components/dicom/DicomStudy';
import type { Plane } from '@/app/components/dicom/DicomLoader';

interface PatientStudyRecord {
  key: string;
  study: DicomStudy;
  loadedAt: number;
}

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

function App() {
  const [niftiData, setNiftiData] = useState<ArrayBuffer | null>(null);
  const [patientStudies, setPatientStudies] = useState<PatientStudyRecord[]>([]);
  const [activePatientKey, setActivePatientKey] = useState<string | null>(null);
  const [, setFileName] = useState<string>('');

  const activeStudy = useMemo(
    () => patientStudies.find((p) => p.key === activePatientKey)?.study || null,
    [patientStudies, activePatientKey],
  );

  const handleFileLoad = (data: ArrayBuffer, name: string) => {
    setNiftiData(data);
    setActivePatientKey(null);
    setFileName(name);
  };

  const handleStudyLoad = (study: DicomStudy) => {
    const identity = study.studyInstanceUID || study.patientId || study.studyName;
    const key = identity.trim() || `study-${Date.now()}`;
    setPatientStudies((prev) => {
      const idx = prev.findIndex((r) => r.key === key);
      if (idx < 0) {
        return [...prev, { key, study, loadedAt: Date.now() }];
      }
      const next = [...prev];
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

  return (
    <div className="h-screen w-screen bg-gray-950 flex flex-col overflow-hidden">
      <main className="flex-1 overflow-hidden flex min-h-0">
        <aside className="w-64 border-r border-gray-800 bg-gray-900 p-3 overflow-y-auto">
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
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        setActivePatientKey(key);
                        setNiftiData(null);
                      }}
                      className={`w-full text-left rounded px-2 py-2 border ${
                        active
                          ? 'bg-blue-700 border-blue-500 text-white'
                          : 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700'
                      }`}
                    >
                      <div className="text-xs font-semibold truncate">{study.patientId || 'unknown-patient'}</div>
                      <div className="text-[11px] opacity-90 truncate">{study.patientName || 'Unknown Patient'}</div>
                      <div className="text-[10px] opacity-80 truncate">{study.studyName}</div>
                      <div className="text-[10px] opacity-80 mt-1">Views: {loadedPlanes.join(', ') || 'none'}</div>
                    </button>
                  );
                })}
            </div>
          )}
        </aside>
        <div className="flex-1 min-w-0 min-h-0">
          <MedicalImageViewer
            niftiData={niftiData}
            studyData={activeStudy}
            onFileLoad={handleFileLoad}
            onStudyLoad={handleStudyLoad}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
