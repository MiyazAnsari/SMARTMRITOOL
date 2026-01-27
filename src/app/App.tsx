import { useState } from 'react';
import { MedicalImageViewer } from '@/app/components/MedicalImageViewer';

function App() {
  const [niftiData, setNiftiData] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string>('');

  const handleFileLoad = (data: ArrayBuffer, name: string) => {
    setNiftiData(data);
    setFileName(name);
  };

  return (
    <div className="h-screen w-screen bg-gray-950 flex flex-col overflow-hidden">
      <main className="flex-1 overflow-hidden">
        <MedicalImageViewer niftiData={niftiData} onFileLoad={handleFileLoad} />
      </main>
    </div>
  );
}

export default App;
