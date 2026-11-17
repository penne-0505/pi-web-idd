import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseRoles, fallbackNames } from "../src/roles.ts";
import { stageRunPlans, STAGE_SLOT, STAGE_TASK } from "../src/review-runs.ts";
import { missingShipped, shippedConfig, shippedConfigDescribe } from "./helpers/shipped-config.ts";

// AC-001: the device stage is declared, it wakes only the role the declaration names (or its fallback), and every
// role in that column reads images. A role that cannot see the pictures would write "no difference" without looking.
// The harness tells the reader that renders an image: Claude Code's Read opens a png, and the stage's pictures are
// handed to it as inputs. The engine cannot tell which models see images, so the column is pinned here and reviewed
// at the config's diff.

// the column is read from the shipped roles.yaml, so where it is missing the whole file is skipped and nothing is read
const roles = missingShipped("roles.yaml").length === 0 ? parseRoles(readFileSync(shippedConfig("roles.yaml"), "utf8")) : parseRoles("roles: {}");

/** whether the role's reader is one the stage hands pictures to (Claude Code's Read) */
const readsImages = (name: string): boolean => roles.roles[name]?.harness === "claude";

shippedConfigDescribe(["roles.yaml"], "the device stage's declaration and its role column", () => {
  test("pipeline.device_check is declared and the stage wakes only its declared role", () => {
    const slot = roles.pipeline.device_check;
    expect(slot, "pipeline.device_check が宣言されている").toBeDefined();
    expect(STAGE_SLOT.device).toBe("device_check");
    // a stage that is not a blind runs the slot's single role; the stage never names another
    expect(stageRunPlans("device", slot, { maxRoutes: 1 }).map((p) => p.role)).toEqual([slot.role]);
  });

  test("the declared role and every fallback in its column read images", () => {
    const slot = roles.pipeline.device_check;
    expect(readsImages(slot.role), `${slot.role} は画像を読める役`).toBe(true);
    for (const name of fallbackNames(roles.roles[slot.role])) {
      expect(readsImages(name), `代わりの ${name} も画像を読める役`).toBe(true);
    }
  });

  test("the role is asked to open the pictures and compare them with the overall statement", () => {
    const task = STAGE_TASK.device;
    expect(task).toMatch(/全体 1 文/);
    expect(task).toMatch(/compare\//);
    expect(task).toMatch(/read で/);
    expect(task).toMatch(/must/);
    expect(task).not.toMatch(/実機/);
  });

  test("a role that cannot see images is not accepted as the stage's role", () => {
    // the check the config's diff review runs: a pi role reads images none of the stage's inputs
    expect(readsImages("device-checker")).toBe(false);
  });
});
