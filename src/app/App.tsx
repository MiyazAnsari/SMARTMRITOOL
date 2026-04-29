import { useState } from 'react';
import { MedicalImageViewer } from '@/app/components/MedicalImageViewer';
import type { DicomStudy } from '@/app/components/dicom/DicomStudy';

function App() {
  const [niftiData, setNiftiData] = useState<ArrayBuffer | null>(null);
  const [studyData, setStudyData] = useState<DicomStudy | null>(null);
  const [, setFileName] = useState<string>('');

  const handleFileLoad = (data: ArrayBuffer, name: string) => {
    setNiftiData(data);
    setStudyData(null);
    setFileName(name);
  };

  const handleStudyLoad = (study: DicomStudy) => {
    setStudyData(study);
    setNiftiData(null);
    setFileName(study.studyName);
  };

  return (
    <div className="h-screen w-screen bg-gray-950 flex flex-col overflow-hidden">
      <main className="flex-1 overflow-hidden">
        <MedicalImageViewer
          niftiData={niftiData}
          studyData={studyData}
          onFileLoad={handleFileLoad}
          onStudyLoad={handleStudyLoad}
        />
      </main>
    </div>
  );
}

export default App;
