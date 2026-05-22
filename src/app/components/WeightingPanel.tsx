import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { StudyUpload } from './dicom/StudyUpload';
import type { DicomStudy } from './dicom/DicomStudy';
import type { Plane } from './dicom/DicomLoader';
import {
  MeasurementWorkflow,
  WorkflowState,
} from './measurement/MeasurementWorkflow';

interface WeightingPanelProps {
  onStudyPlaneSelect?: (plane: Plane) => void;
  onFileLoad?: (data: ArrayBuffer, name: string) => void;
  onStudyLoad?: (study: DicomStudy) => void;
  studyData?: DicomStudy | null;
  activeStudyPlane?: Plane;
  workflow: WorkflowState;
  onWorkflowChange: (s: WorkflowState) => void;
  pixelSpacing: { x: number; y: number };
  onPlaneRequest?: (plane: Plane) => void;
}

export function WeightingPanel({
  onStudyPlaneSelect,
  onFileLoad,
  onStudyLoad,
  studyData,
  activeStudyPlane,
  workflow,
  onWorkflowChange,
  pixelSpacing,
  onPlaneRequest,
}: WeightingPanelProps) {
  return (
    <div className="bg-gray-900 border-l border-gray-800 p-4 overflow-y-auto h-full">
      <h2 className="text-sm font-bold text-blue-300 mb-3">SMART MRI Measurement Tool</h2>

      {(onFileLoad || onStudyLoad) && (
        <StudyUpload
          onNiftiLoad={(buf, name) => onFileLoad?.(buf, name)}
          onStudyLoad={(study) => onStudyLoad?.(study)}
        />
      )}

      {studyData && (
        <div className="mt-2 text-[10px] text-gray-400">
          Loaded study: <span className="text-gray-200">{studyData.studyName}</span>
          <div className="mt-1">
            <div className="mb-1 text-gray-500">Select sequence to view:</div>
            <div className="flex flex-wrap gap-1">
              {(['axial', 'sagittal', 'coronal'] as Plane[]).map((p) => {
                const exists = Boolean(studyData.volumes[p]);
                const active = activeStudyPlane === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onStudyPlaneSelect?.(p)}
                    className={`px-2 py-0.5 rounded capitalize border ${
                      active
                        ? 'bg-blue-600 text-white border-blue-500'
                        : exists
                          ? 'bg-gray-800 text-gray-200 border-gray-700 hover:bg-gray-700'
                          : 'bg-gray-900 text-gray-500 border-gray-800'
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <Separator className="bg-gray-800 my-4" />

      <MeasurementWorkflow
        state={workflow}
        onStateChange={onWorkflowChange}
        pixelSpacing={pixelSpacing}
        onPlaneRequest={onPlaneRequest}
      />
    </div>
  );
}