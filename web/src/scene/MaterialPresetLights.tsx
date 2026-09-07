import type { MaterialPresetLight, MaterialPresetProps } from "../model/materialPresets";
import { isIllustrationMaterialPreset, isMetalMaterialPreset } from "../model/materialPresets";
import { CameraHeadlight } from "./CameraHeadlight";

export function MaterialPresetLights({
  ambientIntensity,
  direction,
  intensityScale = 1,
  lighting,
  mainIntensity,
  presetId,
}: {
  ambientIntensity?: number;
  direction?: [number, number];
  intensityScale?: number;
  lighting: MaterialPresetLight[];
  mainIntensity?: number;
  presetId?: string;
}) {
  // Convert illustration light units rather than amplifying diffuse independently
  // from specular/clearcoat energy. Physical finishes retain their stock BRDFs.
  const lightUnitScale = presetId && presetId !== "cartoon" && isIllustrationMaterialPreset(presetId)
    && !isMetalMaterialPreset(presetId) ? Math.PI : 1;
  return (
    <>
      {lighting.map((light, index) => (
        <MaterialPresetLightRenderer
          ambientIntensity={ambientIntensity}
          direction={direction}
          key={`${index}:${light.type}:${JSON.stringify(light.props)}`}
          intensityScale={intensityScale * lightUnitScale}
          light={light}
          mainIntensity={mainIntensity}
        />
      ))}
    </>
  );
}

function MaterialPresetLightRenderer({
  ambientIntensity,
  direction,
  intensityScale,
  light,
  mainIntensity,
}: {
  ambientIntensity?: number;
  intensityScale: number;
  direction?: [number, number];
  light: MaterialPresetLight;
  mainIntensity?: number;
}) {
  const props = light.props;

  if (light.type === "AmbientLight") {
    return <ambientLight {...resolveLightPropsWithScaledIntensity(
      ambientIntensity === undefined ? props : { ...props, intensity: ambientIntensity },
      intensityScale,
    )} />;
  }

  if (light.type === "HemisphereLight") {
    const { skyColor = "#ffffff", groundColor = "#ffffff", intensity = 1, ...rest } = props;
    return (
      <hemisphereLight
        args={[
          expectColor(skyColor, `${light.type}.props.skyColor`),
          expectColor(groundColor, `${light.type}.props.groundColor`),
          expectNumber(intensity, `${light.type}.props.intensity`) * intensityScale,
        ]}
        {...resolveLightProps(rest)}
      />
    );
  }

  const { color, intensity, offset } = props;
  return (
    <CameraHeadlight
      direction={props.fixedDirection ? undefined : direction}
      color={expectOptionalColor(color, `${light.type}.props.color`)}
      intensity={!props.fixedDirection && mainIntensity !== undefined
        ? mainIntensity
        : expectOptionalNumber(intensity, `${light.type}.props.intensity`)}
      intensityScale={intensityScale}
      offset={expectOptionalVectorTuple(offset, `${light.type}.props.offset`)}
    />
  );
}

function resolveLightProps(props: MaterialPresetProps): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
}

function resolveLightPropsWithScaledIntensity(
  props: MaterialPresetProps,
  intensityScale: number,
): Record<string, unknown> {
  const resolvedProps = resolveLightProps(props);
  const intensity =
    props.intensity === undefined || props.intensity === null
      ? 1
      : expectNumber(props.intensity, "light.props.intensity");

  return {
    ...resolvedProps,
    intensity: intensity * intensityScale,
  };
}

function expectOptionalColor(data: unknown, path: string): string | number | undefined {
  if (data === undefined || data === null) {
    return undefined;
  }
  return expectColor(data, path);
}

function expectColor(data: unknown, path: string): string | number {
  if (typeof data === "string" || typeof data === "number") {
    return data;
  }

  throw new Error(`${path} must be a color string or number.`);
}

function expectOptionalNumber(data: unknown, path: string): number | undefined {
  if (data === undefined || data === null) {
    return undefined;
  }
  return expectNumber(data, path);
}

function expectNumber(data: unknown, path: string): number {
  if (typeof data === "number" && Number.isFinite(data)) {
    return data;
  }

  throw new Error(`${path} must be a finite number.`);
}

function expectOptionalVectorTuple(
  data: unknown,
  path: string,
): readonly [number, number, number] | undefined {
  if (data === undefined || data === null) {
    return undefined;
  }
  if (
    Array.isArray(data) &&
    data.length === 3 &&
    data.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    return [data[0], data[1], data[2]];
  }

  throw new Error(`${path} must be a three-number array.`);
}
