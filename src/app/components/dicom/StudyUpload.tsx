import { useRef, useState } from 'react';
import * as pako from 'pako';
import { Upload, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { loadDicomStudy, type DicomStudy } from './DicomStudy';
import { studyHasVolumes } from './patientStudy';

interface StudyUploadProps {
  /** Called when a single NIfTI file finishes loading. */
  onNiftiLoad: (data: ArrayBuffer, name: string) => void;
  /** Called when a DICOM study (one or more series) finishes loading. */
  onStudyLoad: (study: DicomStudy) => void;
}

export function StudyUpload({ onNiftiLoad, onStudyLoad }: StudyUploadProps) {
  const niftiInputRef = useRef<HTMLInputElement>(null);
  const dicomInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const handleNifti = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setBusy(true);
      setProgress('Reading file…');
      const buf = await file.arrayBuffer();
      if (file.name.endsWith('.gz')) {
        const decompressed = pako.inflate(new Uint8Array(buf));
        const newBuffer = new ArrayBuffer(decompressed.length);
        new Uint8Array(newBuffer).set(decompressed);
        onNiftiLoad(newBuffer, file.name);
      } else {
        onNiftiLoad(buf, file.name);
      }
    } catch (err) {
      console.error(err);
      alert('Could not load the NIfTI file. Make sure it ends in .nii or .nii.gz.');
    } finally {
      setBusy(false);
      setProgress(null);
      event.target.value = '';
    }
  };

  const handleDicom = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || !files.length) return;
    try {
      setBusy(true);
      const dicomFiles = Array.from(files).filter((f) => f.name);
      const patientGroups = new Map<string, File[]>();
      for (const file of dicomFiles) {
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const trimmedRel = rel.includes('/') ? rel.split('/').slice(1).join('/') : rel;
        const patientKey = trimmedRel.split('/')[0] || rel.split('/')[0] || file.name;
        const group = patientGroups.get(patientKey) || [];
        const normalizedFile = new File([file], file.name, {
          type: file.type,
          lastModified: file.lastModified,
        }) as File & { webkitRelativePath?: string };
        Object.defineProperty(normalizedFile, 'webkitRelativePath', {
          value: trimmedRel,
          enumerable: true,
          configurable: true,
        });
        group.push(normalizedFile);
        patientGroups.set(patientKey, group);
      }

      setProgress(`Parsing ${patientGroups.size} patient folder(s)…`);

      let loadedStudies = 0;
      for (const [patientKey, patientFiles] of patientGroups) {
        setProgress(`Parsing ${patientKey} (${patientFiles.length} files)…`);
        const study = await loadDicomStudy(patientFiles, (m) => setProgress(`${patientKey}: ${m}`));
        if (!studyHasVolumes(study)) continue;
        onStudyLoad(study);
        loadedStudies += 1;
      }

      if (loadedStudies === 0) {
        alert('No DICOM volumes could be loaded from that folder.');
      }
    } catch (err) {
      console.error(err);
      alert('Failed to load DICOM study. See the console for details.');
    } finally {
      setBusy(false);
      setProgress(null);
      event.target.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={niftiInputRef}
        type="file"
        accept=".nii,.nii.gz"
        onChange={handleNifti}
        className="hidden"
      />
      <input
        ref={dicomInputRef}
        type="file"
        // @ts-ignore - webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        directory=""
        multiple
        onChange={handleDicom}
        className="hidden"
      />

      <Button
        type="button"
        size="sm"
        onClick={() => dicomInputRef.current?.click()}
        disabled={busy}
        className="bg-blue-600 hover:bg-blue-500 text-white"
      >
        {busy ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        ) : (
          <FolderOpen className="w-4 h-4 mr-2" />
        )}
        Load DICOM study
      </Button>

      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => niftiInputRef.current?.click()}
        disabled={busy}
        className="border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700"
      >
        <Upload className="w-4 h-4 mr-2" />
        Load NIfTI file
      </Button>

      {progress && (
        <div className="text-[10px] text-gray-400 truncate" title={progress}>
          {progress}
        </div>
      )}
    </div>
  );
}
