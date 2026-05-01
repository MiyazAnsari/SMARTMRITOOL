import { DicomData } from './DicomLoader';

// The list of measurements Danish mentioned
// Each one has a name, which plane to show, and step by step instructions
export const MEASUREMENTS = [
  {
    id: 'TT-TG',
    label: 'TT-TG',
    plane: 'axial' as const,
    steps: [
      'Load the axial DICOM sequence',
      'Find the slice showing the trochlear groove',
      'Draw a line tangent to the femoral condyles',
      'Find the slice showing the tibial tubercle',
      'Draw a vertical line through the tibial tubercle',
      'Measure the distance between the two lines',
    ],
  },
  {
    id: 'insal-salvati',
    label: 'Insal Salvati',
    plane: 'sagittal' as const,
    steps: [
      'Load the sagittal DICOM sequence',
      'Find the slice showing the patella and patellar tendon',
      'Draw a line along the patellar tendon length',
      'Draw a line along the patella length',
      'Calculate the ratio of tendon to patella length',
    ],
  },
  {
    id: 'patella-tilt',
    label: 'Patella Tilt',
    plane: 'axial' as const,
    steps: [
      'Load the axial DICOM sequence',
      'Find the slice showing the patella clearly',
      'Draw a line along the patella',
      'Draw a line along the posterior femoral condyles',
      'Measure the angle between the two lines',
    ],
  },
];

// The props this component needs
interface MeasurementMenuProps {
  measurementType: string;
  onMeasurementTypeChange: (type: string) => void;
  dicomData?: DicomData | null;
  onPlaneChange?: (plane: 'axial' | 'sagittal' | 'coronal') => void;
}

export function MeasurementMenu({
  measurementType,
  onMeasurementTypeChange,
  dicomData,
  onPlaneChange,
}: MeasurementMenuProps) {

  // Find the currently selected measurement object
  // e.g. if measurementType is 'TT-TG', this finds the full TT-TG object above
  const selected = MEASUREMENTS.find(m => m.id === measurementType);

  // When user picks a measurement from the dropdown
  const handleSelect = (id: string) => {
    onMeasurementTypeChange(id);

    // Find which plane this measurement needs
    const measurement = MEASUREMENTS.find(m => m.id === id);
    if (measurement && onPlaneChange) {
      // Automatically switch to the right plane
      // e.g. TT-TG needs axial, Insal Salvati needs sagittal
      onPlaneChange(measurement.plane);
    }
  };

  return (
    <div className="p-4 border-b border-gray-700">

      {/* Section title */}
      <h3 className="text-sm font-medium text-gray-300 mb-2">
        Measurement Type
      </h3>

      {/* Dropdown menu */}
      <select
        value={measurementType}
        onChange={(e) => handleSelect(e.target.value)}
        className="w-full bg-gray-800 text-gray-200 border border-gray-600 rounded px-3 py-2 text-sm"
      >
        <option value="">-- Select measurement --</option>
        {MEASUREMENTS.map((m) => (
          // For each measurement in our list, create a dropdown option
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>

      {/* Step by step checklist — only shows when a measurement is selected */}
      {selected && (
        <div className="mt-4">
          <h4 className="text-xs font-medium text-gray-400 mb-2 uppercase tracking-wide">
            Steps
          </h4>
          <ol className="space-y-2">
            {selected.steps.map((step, index) => (
              <li key={index} className="flex items-start space-x-2">
                {/* Step number circle */}
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center mt-0.5">
                  {index + 1}
                </span>
                {/* Step text */}
                <span className="text-xs text-gray-300">{step}</span>
              </li>
            ))}
          </ol>

          {/* Shows which plane will be loaded automatically */}
          <div className="mt-3 px-2 py-1 bg-gray-800 rounded text-xs text-blue-400">
            Auto-loading: <span className="capitalize">{selected.plane}</span> plane
          </div>
        </div>
      )}
    </div>
  );
}