import { describe, expect, test } from "bun:test";

import { createProjectId, slugify } from "../src/utils/ids.js";

describe("ids", () => {
  test("slugify normalizes titles", () => {
    expect(slugify("The Last Empire!!")).toBe("the-last-empire");
  });

  test("createProjectId uses local timestamp + slug", () => {
    const id = createProjectId("The Last Empire", new Date("2026-03-05T13:15:22"));
    expect(id).toBe("2026-03-05_13-15-22_the-last-empire");
  });
});
