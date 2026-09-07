import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, mock, test } from "bun:test";

import type { AtomSpec, BondSpec } from "../src/api/scene";
import { BondInspectorCard } from "../src/app/BondInspectorCard";
import { createDefaultStyle } from "../src/model";

describe("BondInspectorCard", () => {
  test("places Delete immediately before Hide and keeps their actions distinct", async () => {
    const user = userEvent.setup();
    const onHide = mock();
    const onDelete = mock();
    const startAtom = atom("Na-0", "Na", 0);
    const endAtom = atom("Cl-1", "Cl", 1);
    const bond = selectedBond();

    render(
      <BondInspectorCard
        colorScheme="jmol"
        info={{
          bond,
          endAtom,
          family: { elements: ["Na", "Cl"], key: "Na|Cl", minLength: 1, maxLength: 1 },
          startAtom,
        }}
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
      "Close bond info",
      "Delete selected objects",
      "Hide bond",
      "Copy bond info",
      "Locate bond in Objects",
    ]);
    expect(screen.getByText("Cell shift").isConnected).toBe(true);
    expect(screen.getByText("1, -1, 0").isConnected).toBe(true);

    const deleteButton = screen.getByRole("button", { name: "Delete selected objects" });
    expect(deleteButton.querySelector("svg")?.getAttribute("fill")).toBe("none");
    await user.click(deleteButton);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onHide).not.toHaveBeenCalled();

    const hideButton = screen.getByRole("button", { name: "Hide bond" });
    await user.hover(hideButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Hide bond (H)");
    await user.click(hideButton);
    expect(onHide).toHaveBeenCalledWith(bond);
  });
});

function atom(id: string, element: string, siteIndex: number): AtomSpec {
  return {
    element,
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

function selectedBond(): BondSpec {
  return {
    endAtomIndex: 1,
    endImageOffset: [0, 0, 0],
    endSiteId: "Cl-1",
    familyKey: "Na|Cl",
    id: "bond:one",
    length: 1,
    relationId: "relation:one",
    relativeImageOffset: [1, -1, 0],
    startAtomIndex: 0,
    startImageOffset: [0, 0, 0],
    startSiteId: "Na-0",
    visibilityDependencies: [],
    visibilityDependencyGroups: [],
  };
}
