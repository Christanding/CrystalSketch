import type {
  CrystalCameraPrimaryDirection,
  CrystalCameraState,
} from "../../../model";
import { PrimaryAxisRollSection } from "./orientation/PrimaryAxisRollSection";

export function OrientationTabContent({
  cameraState,
  onCameraPrimaryChange,
  onCameraRollPreviewChange,
  onCameraRollPreviewStart,
  onCameraRollChange,
}: {
  cameraState: CrystalCameraState;
  onCameraPrimaryChange: (primary: CrystalCameraPrimaryDirection) => void;
  onCameraRollPreviewChange: (rollDegrees: number) => void;
  onCameraRollPreviewStart: () => void;
  onCameraRollChange: (rollDegrees: number) => void;
}) {
  return (
    <div className="flex flex-col" data-camera-tab-keepalive="">
      <PrimaryAxisRollSection
        primary={cameraState.primary}
        rollDegrees={cameraState.rollDegrees}
        onCameraPrimaryChange={onCameraPrimaryChange}
        onCameraRollChange={onCameraRollChange}
        onCameraRollPreviewChange={onCameraRollPreviewChange}
        onCameraRollPreviewStart={onCameraRollPreviewStart}
      />
    </div>
  );
}
