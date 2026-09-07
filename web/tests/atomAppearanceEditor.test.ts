import { describe, expect, test } from "bun:test";
import type { Dispatch, SetStateAction } from "react";

import type { AtomSpec } from "../src/api/scene";
import { createAtomAppearanceEditor } from "../src/app/inspector/atomAppearanceEditor";
import {
  createCustomColormapFromStyle,
  createDefaultStyle,
  setAtomOverrideProperty,
  setAtomColorOverrides,
  setElementOverrideProperty,
  type StyleState,
} from "../src/model";
import { createAtomRenderItems } from "../src/scene/AtomRenderItems";

describe("atom appearance editor", () => {
  test("batch color overrides preserve other appearance fields and share the render/export color source", () => {
    const first = atom("Na-0", 0), other = atom("Na-1", 1);
    const image = { ...first, id: "Na-0-image-1-0-0", isPeriodicImage: true };
    const style = createDefaultStyle();
    style.objectStyles.atomOverrides[first.siteId] = { radius: 0.7, opacity: 60 };
    style.objectStyles.atomOverrides[image.id] = { color: "#ff0000" };
    const before = JSON.stringify(style);
    const objectStyles = setAtomColorOverrides(style.objectStyles, [first, image], "#9876ab");
    const items = createAtomRenderItems({ atoms: [first, image, other], atomOpacity: 100, colorScheme: style.colorScheme,
      style: { ...style, objectStyles } });
    expect(items[0]!.color).toBe("#9876ab");
    expect(items[1]!.color).toBe("#9876ab");
    expect(items[0]!.opacity).toBe(0.6);
    expect(items[0]!.radius).toBe(0.7);
    expect(items[2]!.color).not.toBe("#9876ab");
    expect(setAtomColorOverrides(objectStyles, [first, image], "#9876ab")).toBe(objectStyles);
    const restored = setAtomColorOverrides(objectStyles, [first, image], null);
    expect(restored.atomOverrides[first.siteId]).toEqual({ radius: 0.7, opacity: 60 });
    expect(restored.atomOverrides[image.id]).toBeUndefined();
    expect(JSON.stringify(style)).toBe(before);
  });

  test("applies an element appearance as one functional update against current style", () => {
    const atoms = [atom("Na-0", 0), atom("Na-1", 1)];
    const initialStyle = createDefaultStyle();
    const customColormap = createCustomColormapFromStyle(atoms, initialStyle);
    const elementOverrides = setElementOverrideProperty(
      initialStyle.objectStyles,
      "Na",
      "opacity",
      73,
    );
    const objectStyles = setAtomOverrideProperty(
      elementOverrides,
      "Na-0",
      "opacity",
      21,
    );
    const currentStyle: StyleState = {
      ...initialStyle,
      colorSchemeMode: "custom",
      colorScheme: customColormap.baseColorScheme,
      customColormap: {
        ...customColormap,
        elements: { ...customColormap.elements, Na: "#123456" },
      },
      objectStyles,
    };
    const updates: SetStateAction<StyleState>[] = [];
    const elementColorChanges: [string, string][] = [];
    const editor = createAtomAppearanceEditor({
      atomOpacity: 100,
      atoms,
      atomsVisible: true,
      onElementColorChange: (element, color) => {
        elementColorChanges.push([element, color]);
      },
      onStyleChange: ((update) => updates.push(update)) as Dispatch<
        SetStateAction<StyleState>
      >,
      style: initialStyle,
    });

    editor.applyElementToAllAtoms("Na");

    expect(updates).toHaveLength(1);
    expect(typeof updates[0]).toBe("function");
    expect(elementColorChanges).toEqual([]);
    const update = updates[0];
    if (typeof update !== "function")
      throw new Error("expected functional update");
    const nextStyle = update(currentStyle);
    expect(nextStyle.objectStyles.elementOverrides.Na?.opacity).toBe(73);
    expect(
      nextStyle.objectStyles.atomOverrides["Na-0"]?.opacity,
    ).toBeUndefined();
    expect(nextStyle.customColormap?.elements.Na).toBe("#123456");
  });
});

function atom(id: string, siteIndex: number): AtomSpec {
  return {
    element: "Na",
    fractionalPosition: [siteIndex, 0, 0],
    id,
    imageOffset: [0, 0, 0],
    imageReasons: [],
    isPeriodicImage: false,
    position: [siteIndex, 0, 0],
    siteId: id,
    siteIndex,
    visibilityDependencies: [],
    visibilityDependencyGroups: [],
  };
}
