import { useRef, useState } from 'react';
import * as pako from 'pako';
// @ts-ignore - dicom-parser ships its own .d.ts but JS module shape varies
import dicomParser from 'dicom-parser';
import { Upload, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { loadDicomStudy, type DicomStudy } from './DicomStudy';
import { groupFilesByDirectory, isProbablyDicom } from './DicomLoader';
import { studyHasVolumes } from './patientStudy';

interface StudyUploadProps {
  /** Called when a single NIfTI file finishes loading. */
  onNiftiLoad: (data: ArrayBuffer, name: string) => void;
  /** Called when a DICOM study (one or more series) finishes loading. */
  onStudyLoad: (study: DicomStudy) => void;
}

// ---------------------------------------------------------------------------
// Lightweight DICOM metadata peek (reads a single tag without parsing pixels)
// ---------------------------------------------------------------------------

const TAG_PATIENT_ID = 'x00100020';

function peekPatientId(buffer: ArrayBuffer): string | null {
  try {
    const byteArray = new Uint8Array(buffer);
    const dataSet = dicomParser.parseDicom(byteArray);
    const v = dataSet.string(TAG_PATIENT_ID);
    return v ? v.trim() : null;
  } catch {
    return null;
  }
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

      // ---- group files by DICOM PatientID --------------------------------
      // 1. Split files by their immediate parent directory (same as
      //    loadDicomStudy does internally).
      // 2. Peek at the first file in each directory to read PatientID.
      // 3. Merge directories that share the same PatientID into one study.
      // This uses authoritative DICOM metadata instead of fragile folder-name
      // heuristics — works with any naming convention (LeftKnee, Knee_MRI_Lt,
      // 9001695, etc.).
      const dirGroups = groupFilesByDirectory(dicomFiles);
      const patientGroups = new Map<string, File[]>();

      for (const [, dirFiles] of dirGroups) {
        // Peek at the first DICOM-looking file in this directory
        const dicomFile = dirFiles.find((f) => isProbablyDicom(f.name));
        let patientId = 'unknown';
        if (dicomFile) {
          const buf = await dicomFile.arrayBuffer();
          const id = peekPatientId(buf);
          if (id) patientId = id;
        }

        const group = patientGroups.get(patientId) || [];
        for (const f of dirFiles) group.push(f);
        patientGroups.set(patientId, group);
      }

      // All studies loaded in this batch share a token so handleStudyLoad
      // never merges different patients from the same top-level pick.
      const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setProgress(`Parsing ${patientGroups.size} patient(s)…`);

      let loadedStudies = 0;
      for (const [patientId, patientFiles] of patientGroups) {
        setProgress(`Parsing patient ${patientId} (${patientFiles.length} files)…`);
        const study = await loadDicomStudy(
          patientFiles,
          (m) => setProgress(`${patientId}: ${m}`),
          patientId !== 'unknown' ? patientId : undefined,
        );
        study.batchId = batchId;

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
