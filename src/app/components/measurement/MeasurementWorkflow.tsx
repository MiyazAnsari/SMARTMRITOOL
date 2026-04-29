import { CheckCircle2, Circle, RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';
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
  /** Notify parent when the protocol's required plane needs to become active. */
  onPlaneRequest?: (plane: 'axial' | 'sagittal' | 'coronal') => void;
}

export function MeasurementWorkflow({
  state,
  onStateChange,
  pixelSpacing,
  onPlaneRequest,
}: MeasurementWorkflowProps) {
  const protocol = getProtocol(state.protocolId);
  const activeStep = protocol?.steps[state.activeStepIndex];

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

  const clearStep = (stepId: string, idx: number) => {
    const next = { ...state.stepResults };
    delete next[stepId];
    onStateChange({ ...state, stepResults: next, activeStepIndex: idx });
  };

  return (
    <div className="border-b border-gray-800 pb-4 mb-4">
      <h3 className="text-sm font-semibold text-blue-300 mb-2">Measurement Type</h3>

      <select
        value={state.protocolId || ''}
        onChange={(e) => handleSelect(e.target.value)}
        className="w-full bg-gray-800 text-gray-200 border border-gray-700 rounded px-2 py-1.5 text-sm mb-3"
      >
        <option value="">— Select a measurement —</option>
        {MEASUREMENT_PROTOCOLS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      {protocol && (
        <>
          <div className="text-xs text-gray-400 mb-2">{protocol.description}</div>
          <div className="text-xs text-blue-400 mb-3">
            Required plane:{' '}
            <span className="capitalize font-medium">{protocol.requiredPlane}</span>
            {onPlaneRequest && (
              <button
                onClick={() => onPlaneRequest(protocol.requiredPlane)}
                className="ml-2 underline hover:text-blue-300"
              >
                show
              </button>
            )}
          </div>

          <ol className="space-y-2 mb-3">
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
                  onClick={() => goToStep(idx)}
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
            className="mt-3 w-full border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700"
            onClick={reset}
          >
            <RotateCcw className="w-3 h-3 mr-1" /> Reset measurement
          </Button>
        </>
      )}
    </div>
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
