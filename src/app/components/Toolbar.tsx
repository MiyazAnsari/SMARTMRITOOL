import { Button } from '@/app/components/ui/button';
import { Separator } from '@/app/components/ui/separator';
import { 
  Ruler, 
  Triangle, 
  Trash2,
  MousePointer
} from 'lucide-react';
import { MeasurementTool, type Measurement } from './MedicalImageViewer';
import { ScrollArea } from '@/app/components/ui/scroll-area';
import { useState } from 'react';

interface ToolbarProps {
  activeTool: MeasurementTool;
  onToolChange: (tool: MeasurementTool) => void;
  measurements: Measurement[];
  onMeasurementDelete: (id: string) => void;
  /** show/hide crosshair in viewport */
  showCrosshair: boolean;
  onToggleCrosshair: () => void;
  /** compute auto window/level for current slice */
  onAutoWindowLevel: () => void;
}

export function Toolbar({ activeTool, onToolChange, measurements, onMeasurementDelete, showCrosshair, onToggleCrosshair, onAutoWindowLevel }: ToolbarProps) {
  const tools: { id: MeasurementTool; icon: any; label: string }[] = [
    { id: 'none', icon: MousePointer, label: 'Select' },
    { id: 'distance', icon: Ruler, label: 'Distance' },
    { id: 'angle', icon: Triangle, label: 'Angle' },
  ];
  // Group measurements by groupId
  const groups = measurements.reduce((acc, m) => {
    const key = m.groupId || 'ungrouped';
    if (!acc[key]) acc[key] = [];
    acc[key].push(m);
    return acc;
  }, {} as Record<string, typeof measurements>);

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  return (
    <div className="bg-gray-900 border-r border-gray-800 flex flex-col w-48">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300">Measurement Tools</h2>
          <div className="flex items-center space-x-2">
            <Button
              size="sm"
              variant={showCrosshair ? 'default' : 'ghost'}
              className={showCrosshair ? 'bg-blue-600 text-white' : 'text-gray-300'}
              onClick={() => onToggleCrosshair()}
            >
              Crosshair
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-gray-300"
              onClick={() => onAutoWindowLevel()}
            >
              Auto WL
            </Button>
          </div>
        </div>
        <div className="space-y-1">
          {tools.map(tool => {
            const Icon = tool.icon;
            return (
              <Button
                key={tool.id}
                variant={activeTool === tool.id ? 'default' : 'ghost'}
                className={`w-full justify-start ${
                  activeTool === tool.id 
                    ? 'bg-blue-600 text-white hover:bg-blue-700' 
                    : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                }`}
                onClick={() => onToolChange(tool.id)}
              >
                <Icon className="mr-2 h-4 w-4" />
                {tool.label}
              </Button>
            );
          })}
        </div>
      </div>

      <Separator className="bg-gray-800" />

      <div className="flex-1 p-4 overflow-hidden flex flex-col">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Measurements</h2>
        <ScrollArea className="flex-1">
          <div className="space-y-2 pr-3">
            {measurements.length === 0 ? (
              <p className="text-xs text-gray-500 italic">No measurements yet</p>
            ) : (
              Object.entries(groups).map(([groupId, groupMeasurements]) => (
                <div key={groupId} className="mb-2">
                  <button
                    className="w-full flex items-center justify-between text-xs font-semibold text-gray-300 hover:text-white py-1"
                    onClick={() => setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }))}
                  >
                    <span>{groupId === 'ungrouped' ? 'Measurements' : groupId.split('-').slice(0, -1).join('-').toUpperCase()}</span>
                    <span>{collapsedGroups[groupId] ? '▶' : '▼'}</span>
                  </button>
                  {!collapsedGroups[groupId] && (
                    <div className="space-y-2">
                      {groupMeasurements.map((measurement) => (
                        <div key={measurement.id} className="flex items-start justify-between bg-gray-800 p-2 rounded text-xs">
                          <div className="flex-1 mr-2">
                            <div className="font-medium text-gray-300 capitalize">{measurement.type}</div>
                            <div className="text-gray-500 mt-0.5">{measurement.plane} - Slice {measurement.slice}</div>
                            {measurement.value && <div className="text-blue-400 mt-1">{measurement.value}</div>}
                          </div>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-gray-500 hover:text-red-400 hover:bg-gray-700" onClick={() => onMeasurementDelete(measurement.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
