/**
 * topic 規則：NVIDIA CEO／resign 不得誤標 diplomacy
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectEventsFromHit } from "./collector";
import { planResearch } from "./planner";
import type { RawSearchHit } from "./types";

describe("topic 規則", () => {
  it("NVIDIA CEO resign → corporate，非 diplomacy", () => {
    const plan = planResearch({
      text: "NVIDIA 過去 7 天新聞",
      now: new Date("2026-11-16T04:00:00+08:00"),
    });
    const hit: RawSearchHit = {
      brief: "SYNTHETIC brief only",
      provider: "test",
      queries: ["nvidia ceo resign"],
      sources: [
        {
          title: "NVIDIA CEO Jensen Huang resigns amid board review",
          uri: "https://www.reuters.com/synthetic/nvidia-ceo-resign",
          publishedAt: "2026-11-12T08:00:00Z",
        },
      ],
      pages: [
        {
          title: "NVIDIA CEO Jensen Huang resigns amid board review",
          uri: "https://www.reuters.com/synthetic/nvidia-ceo-resign",
          excerpt:
            "NVIDIA CEO Jensen Huang resigns effective immediately after a board review. An interim chief executive was named while corporate succession continues. No change to earnings guidance.",
          publishedAt: "2026-11-12T08:00:00Z",
          fetchStatus: "ok",
        },
      ],
    };
    const corpus = collectEventsFromHit(plan, hit);
    assert.ok(corpus.events.length >= 1);
    assert.equal(corpus.events[0].topic, "corporate");
    assert.notEqual(corpus.events[0].topic, "diplomacy");
  });

  it("峰會／習近平 → diplomacy", () => {
    const plan = planResearch({
      text: "川普最新消息",
      now: new Date("2026-11-16T04:00:00+08:00"),
    });
    const hit: RawSearchHit = {
      brief: "x",
      provider: "test",
      queries: ["summit"],
      sources: [
        {
          title: "Trump Xi Putin plan trilateral summit in China",
          uri: "https://www.reuters.com/synthetic/summit",
          publishedAt: "2026-11-14T08:00:00Z",
        },
      ],
      pages: [
        {
          title: "Trump Xi Putin plan trilateral summit in China",
          uri: "https://www.reuters.com/synthetic/summit",
          excerpt:
            "White House officials said Trump, Xi and Putin may hold a trilateral summit on the sidelines of APEC to discuss diplomacy and security.",
          publishedAt: "2026-11-14T08:00:00Z",
          fetchStatus: "ok",
        },
      ],
    };
    const corpus = collectEventsFromHit(plan, hit);
    assert.equal(corpus.events[0].topic, "diplomacy");
  });
});
