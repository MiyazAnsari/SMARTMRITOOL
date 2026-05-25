import { useMemo, useState } from 'react';
import { CheckCircle2, Circle, RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import type { Measurement } from '../MedicalImageViewer';
import {
  MEASUREMENT_PROTOCOLS,
  MeasurementProtocol,
  MeasurementResult,
  StepResult,
  getProtocol,
} from './MeasurementProtocols';

export interface WorkflowState {
  protocolId: string | null;
  /** Index of the currently-active step. */
  activeStepIndex: number;
  /** Per-step results keyed by step id. */
  stepResults: Record<string, StepResult>;
}

export const initialWorkflowState: WorkflowState = {
  protocolId: null,
  activeStepIndex: 0,
  stepResults: {},
};

interface MeasurementWorkflowProps {
  state: WorkflowState;
  onStateChange: (s: WorkflowState) => void;
  /** Pixel spacing of the active volume — used to convert px → mm. */
  pixelSpacing: { x: number; y: number };
  measurements?: Measurement[];
  selectedMeasurementId?: string | null;
  onMeasurementSelect?: (id: string | null) => void;
  onStepRedo?: (stepId: string) => void;
  /** Notify parent when the protocol's required plane needs to become active. */
  onPlaneRequest?: (plane: 'axial' | 'sagittal' | 'coronal') => void;
}

export function MeasurementWorkflow({
  state,
  onStateChange,
  pixelSpacing,
  measurements = [],
  selectedMeasurementId = null,
  onMeasurementSelect,
  onStepRedo,
  onPlaneRequest,
}: MeasurementWorkflowProps) {
  const [open, setOpen] = useState(true);
  const protocol = getProtocol(state.protocolId);
  const activeStep = protocol?.steps[state.activeStepIndex];
  const protocolGroups = useMemo(() => {
    const byPlane: Record<'axial' | 'sagittal' | 'coronal', MeasurementProtocol[]> = {
      axial: [],
      sagittal: [],
      coronal: [],
    };
    for (const item of MEASUREMENT_PROTOCOLS) {
      byPlane[item.requiredPlane].push(item);
    }
    return [
      { id: 'axial', label: 'Axial measurements', plane: 'axial' as const, protocols: byPlane.axial },
      { id: 'sagittal', label: 'Sagittal measurements', plane: 'sagittal' as const, protocols: byPlane.sagittal },
      { id: 'coronal', label: 'Coronal measurements', plane: 'coronal' as const, protocols: byPlane.coronal },
    ].filter((group) => group.protocols.length > 0);
  }, []);

  const result: MeasurementResult | null = protocol
    ? protocol.compute(state.stepResults, pixelSpacing)
    : null;

  const handleSelect = (id: string) => {
    const p = getProtocol(id);
    onStateChange({
      protocolId: id || null,
      activeStepIndex: 0,
      stepResults: {},
    });
    if (p && onPlaneRequest) onPlaneRequest(p.requiredPlane);
  };

  const reset = () => {
    onStateChange({
      protocolId: state.protocolId,
      activeStepIndex: 0,
      stepResults: {},
    });
  };

  const goToStep = (i: number) => {
    onStateChange({ ...state, activeStepIndex: i });
  };

  const selectMeasurementForStep = (stepId: string, primitive: string) => {
    if (!protocol) return;
    const step = protocol.steps.find((s) => s.id === stepId);
    if (!step) return;
    const match = [...measurements]
      .reverse()
      .find(
        (m) =>
          m.workflowStepId === stepId ||
          (m.label === step.label && (m.type === primitive || (primitive === 'point' && m.type === 'perpendicular'))),
      );
    if (match) onMeasurementSelect?.(match.id);
  };

  const clearStep = (stepId: string, idx: number) => {
    const next = { ...state.stepResults };
    delete next[stepId];
    onStateChange({ ...state, stepResults: next, activeStepIndex: idx });
    onStepRedo?.(stepId);
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-gray-800 pb-4 mb-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-blue-300">Measurement Menu</h3>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-gray-300 hover:text-white">
            {open ? 'Collapse' : 'Expand'}
          </Button>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent className="space-y-3">
        <div className="space-y-2">
          {protocolGroups.map((group) => (
            <div key={group.id} className="rounded border border-gray-800 bg-gray-950/50 p-2">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                {group.label}
              </div>
              <div className="grid gap-1.5">
                {group.protocols.map((item) => {
                  const isActive = state.protocolId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelect(item.id)}
                      className={`w-full rounded border px-2 py-2 text-left text-xs transition-colors ${
                        isActive
                          ? 'border-blue-500 bg-blue-900/35 text-white'
                          : 'border-gray-700 bg-gray-800/70 text-gray-200 hover:bg-gray-700'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{item.label}</span>
                        <span className="text-[10px] uppercase tracking-wide text-gray-400 capitalize">
                          {item.requiredPlane}
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] leading-snug text-gray-400">{item.description}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {protocol && (
          <>
            <div className="rounded border border-blue-900/50 bg-blue-950/30 p-2 text-xs text-gray-200">
              <div className="font-medium text-blue-200">{protocol.label}</div>
              <div className="mt-1 text-gray-400">{protocol.description}</div>
              <div className="mt-2 text-blue-300">
                Required plane:{' '}
                <span className="capitalize font-medium text-blue-100">{protocol.requiredPlane}</span>
                {onPlaneRequest && (
                  <button
                    onClick={() => onPlaneRequest(protocol.requiredPlane)}
                    className="ml-2 underline hover:text-blue-200"
                  >
                    show
                  </button>
                )}
              </div>
            </div>

            <ol className="space-y-2">
              {protocol.steps.map((step, idx) => {
                const isDone = !!state.stepResults[step.id];
                const isActive = idx === state.activeStepIndex && !isDone;
                return (
                  <li
                    key={step.id}
                    className={`rounded p-2 text-xs cursor-pointer ${
                      isActive
                        ? 'bg-blue-900/40 border border-blue-700'
                        : isDone
                          ? 'bg-gray-800/60'
                          : 'bg-gray-800/30 hover:bg-gray-800/60'
                    }`}
                    onClick={() => {
                      goToStep(idx);
                      selectMeasurementForStep(step.id, step.primitive);
                    }}
                  >
                    <div className="flex items-start gap-2">
                      {isDone ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                      ) : (
                        <Circle
                          className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                            isActive ? 'text-blue-400' : 'text-gray-500'
                          }`}
                        />
                      )}
                      <div className="flex-1">
                        <div
                          className={`font-medium ${
                            isDone
                              ? 'text-gray-400 line-through'
                              : isActive
                                ? 'text-blue-200'
                                : 'text-gray-300'
                          }`}
                        >
                          {idx + 1}. {step.label}
                        </div>
                        {isActive && (
                          <div className="text-gray-300 mt-1 leading-snug">
                            {step.instruction}
                          </div>
                        )}
                        {isDone && (
                          <button
                            className="text-[10px] text-blue-400 hover:text-blue-300 mt-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              clearStep(step.id, idx);
                            }}
                          >
                            Redo
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            {result && (
              <div className="rounded bg-emerald-900/30 border border-emerald-700 p-2 text-xs">
                <div className="font-semibold text-emerald-300">{result.summary}</div>
                {result.interpretation && (
                  <div className="text-emerald-200 mt-1">{result.interpretation}</div>
                )}
              </div>
            )}

            <Button
              size="sm"
              variant="outline"
              className="mt-2 w-full border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700"
              onClick={reset}
            >
              <RotateCcw className="w-3 h-3 mr-1" /> Reset measurement
            </Button>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Helper: given a primitive drawn at the current active step, fold it back into
 * workflow state and advance to the next step. Returns the new state.
 */
export function recordStepResult(
  state: WorkflowState,
  protocol: MeasurementProtocol,
  result: StepResult,
): WorkflowState {
  const step = protocol.steps[state.activeStepIndex];
  if (!step) return state;
  const stepResults = { ...state.stepResults, [step.id]: result };
  // Find the next not-yet-completed step
  let nextIdx = state.activeStepIndex + 1;
  while (nextIdx < protocol.steps.length && stepResults[protocol.steps[nextIdx].id]) {
    nextIdx++;
  }
  return {
    ...state,
    stepResults,
    activeStepIndex: Math.min(nextIdx, protocol.steps.length - 1),
  };
}
