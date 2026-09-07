import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import type { AtomSpec } from "../src/api/scene";
import { AtomInspectorCard } from "../src/app/AtomInspectorCard";
import { createDefaultStyle, setAtomColorOverrides, type StyleState } from "../src/model";
import { ColorPickerRegistryProvider } from "../src/app/colorPickerRegistry";

describe("AtomInspectorCard", () => {
  test("one palette choice colors the selected sites uniformly and restores only their colors", async () => {
    const user = userEvent.setup();
    const first = atom("Al-1", "Al-1", false);
    const image = atom("Al-1-image-1-0-0", "Al-1", true);
    const second = { ...atom("Cu-2", "Cu-2", false), element: "Cu" };
    const atoms = [first, image, second];
    const initial = createDefaultStyle();
    initial.colorScheme = "jmol";
    initial.objectStyles.atomOverrides["Al-1"] = { radius: 0.8, opacity: 42 };
    initial.objectStyles.atomOverrides["I-3"] = { color: "#abcdef" };
    let current: StyleState = initial;
    function Harness() {
      const [style, setStyle] = useState(initial);
      current = style;
      return <ColorPickerRegistryProvider><AtomInspectorCard colorScheme="jmol" info={{ atom: image, canonicalAtom: first }}
        selectedAtoms={atoms} isInspectorOpen={false} onClose={() => {}} onDelete={() => {}} onHide={() => {}} style={style}
        onColorChange={color => setStyle(value => ({ ...value, objectStyles: setAtomColorOverrides(value.objectStyles, atoms, color) }))} />
      </ColorPickerRegistryProvider>;
    }
    render(<Harness />);
    expect(screen.getByText("2 atoms selected")).toBeTruthy();
    expect(screen.queryByText("Cell offset")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change color of 2 selected atoms" }));
    const choice = within(screen.getByRole("radiogroup", { name: "Current palette" })).getAllByRole("radio")[0]!;
    const color = choice.getAttribute("aria-label")!.match(/#[0-9a-f]{6}/i)![0];
    await user.click(choice);
    expect(current.objectStyles.atomOverrides["Al-1"]).toEqual({ color, radius: 0.8, opacity: 42 });
    expect(current.objectStyles.atomOverrides["Cu-2"]).toEqual({ color });
    expect(current.objectStyles.atomOverrides["I-3"]).toEqual({ color: "#abcdef" });
    expect(current.colorScheme).toBe("jmol");
    expect(current.colorSchemeMode).toBe(initial.colorSchemeMode);
    expect(current.customColormap).toBe(initial.customColormap);
    await user.click(screen.getByRole("button", { name: "Restore element colors" }));
    expect(current.objectStyles.atomOverrides["Al-1"]).toEqual({ radius: 0.8, opacity: 42 });
    expect(current.objectStyles.atomOverrides["Cu-2"]).toBeUndefined();
    expect(current.objectStyles.atomOverrides["I-3"]).toEqual({ color: "#abcdef" });
  });

  test("places Delete immediately before Hide and keeps their actions distinct", async () => {
    const user = userEvent.setup();
    const onHide = mock();
    const onDelete = mock();
    const canonicalAtom = atom("Al-1", "Al-1", false);
    const imageAtom = {
      ...atom("Al-1-image-1-0-0", "Al-1", true),
      fractionalPosition: [1.25, 0.5, 0.15] as [number, number, number],
      imageOffset: [1, 0, 0] as [number, number, number],
      position: [6, 2, 2] as [number, number, number],
    };

    render(
      <AtomInspectorCard
        colorScheme="jmol"
        info={{ atom: imageAtom, canonicalAtom }}
        isInspectorOpen={false}
        onClose={() => {}}
        onDelete={onDelete}
        onHide={onHide}
        onLocateInObjects={() => {}}
        style={createDefaultStyle()}
      />,
    );

    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Close atom info",
      "Delete selected objects",
      "Hide atom",
      "Copy atom info",
      "Locate atom in Objects",
    ]);

    const deleteButton = screen.getByRole("button", { name: "Delete selected objects" });
    expect(deleteButton.querySelector("svg")?.getAttribute("fill")).toBe("none");
    await user.click(deleteButton);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onHide).not.toHaveBeenCalled();

    const hideButton = screen.getByRole("button", { name: "Hide atom" });
    await user.hover(hideButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Hide atom (H)");
    await user.click(hideButton);
    expect(onHide).toHaveBeenCalledWith("Al-1");
  });
});

function atom(id: string, siteId: string, isPeriodicImage: boolean): AtomSpec {
  return {
    element: "Al",
    fractionalPosition: [0.25, 0.5, 0.15],
    id,
    imageOffset: [0, 0, 0],
    imageReasons: isPeriodicImage ? ["boundary"] : [],
    isPeriodicImage,
    position: [1, 2, 2],
    siteId,
    siteIndex: 1,
    visibilityDependencies: isPeriodicImage ? ["boundaryAtoms"] : [],
    visibilityDependencyGroups: isPeriodicImage ? [["boundaryAtoms"]] : [],
  };
}
