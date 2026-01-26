import { useState } from 'react';
import { MedicalImageViewer } from '@/app/components/MedicalImageViewer';
import { FileUpload } from '@/app/components/FileUpload';

function App() {
  const [niftiData, setNiftiData] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string>('');

  const handleFileLoad = (data: ArrayBuffer, name: string) => {
    setNiftiData(data);
    setFileName(name);
  };

  return (
    <div className="h-screen w-screen bg-gray-950 flex flex-col overflow-hidden">
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-white">SMART MRI Algorithm</h1>
            {fileName && <p className="text-sm text-gray-400 mt-0.5">{fileName}</p>}
          </div>
          <FileUpload onFileLoad={handleFileLoad} />
        </div>
      </header>
      
      <main className="flex-1 overflow-hidden">
        {niftiData ? (
          <MedicalImageViewer niftiData={niftiData} />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-md">
              <svg className="mx-auto h-16 w-16 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <h3 className="mt-4 text-lg font-medium text-gray-300">No image loaded</h3>
              <p className="mt-2 text-sm text-gray-500">Load imaging data (.nii or .nii.gz) to begin</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
