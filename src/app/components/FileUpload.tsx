import { useRef } from 'react';
import { Button } from '@/app/components/ui/button';
import { Upload } from 'lucide-react';
import * as pako from 'pako';

interface FileUploadProps {
  onFileLoad: (data: ArrayBuffer, fileName: string) => void;
}

export function FileUpload({ onFileLoad }: FileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      
      // Check if file is gzipped
      if (file.name.endsWith('.gz')) {
        const decompressed = pako.inflate(new Uint8Array(arrayBuffer));
        // Create a new ArrayBuffer by copying the decompressed data
        const newBuffer = new ArrayBuffer(decompressed.length);
        const newView = new Uint8Array(newBuffer);
        newView.set(decompressed);
        onFileLoad(newBuffer, file.name);
      } else {
        onFileLoad(arrayBuffer, file.name);
      }
    } catch (error) {
      console.error('Error loading file:', error);
      alert('Error loading file. Please ensure it is a valid NIfTI file.');
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".nii,.nii.gz"
        onChange={handleFileChange}
        className="hidden"
      />
      <Button
        onClick={() => fileInputRef.current?.click()}
        variant="outline"
        className="border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700"
      >
        <Upload className="mr-2 h-4 w-4" />
        Load NIfTI File
      </Button>
    </>
  );
}