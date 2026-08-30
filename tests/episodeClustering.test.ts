import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { ProjectionsDb } from "../src/projections/db.js";
import { rebuildProjections } from "../src/projections/rebuild.js";
import { clusterEpisodeMarkers, extractNarrativeYear, type EpisodeMarkerEvent } from "../src/projections/episodes.js";
import { freshTestDbPath } from "../src/test/dbPath.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";

function marker(overrides: Partial<EpisodeMarkerEvent> & Pick<EpisodeMarkerEvent, "extractionEventId" | "sourceEventId" | "toldAt" | "kind" | "text">): EpisodeMarkerEvent {
  return { participantEntityIds: [], ...overrides };
}

describe("extractNarrativeYear — deterministic, text-only, no relative-date resolution", () => {
  it("finds an explicit 4-digit year stated in the text", () => {
    expect(extractNarrativeYear("Back in 1995 my sister and I had a huge fight.")).toBe("1995");
  });

  it("finds a near-future year too — no bias toward the past", () => {
    expect(extractNarrativeYear("We're planning the reunion for 2030.")).toBe("2030");
  });

  it("returns null for a relative date phrase — this is the documented, honest gap, not a bug", () => {
    expect(extractNarrativeYear("Three years ago we had a huge fight.")).toBeNull();
    expect(extractNarrativeYear("When I was in college we had a huge fight.")).toBeNull();
  });

  it("returns null when nothing date-shaped appears at all", () => {
    expect(extractNarrativeYear("We had a huge fight.")).toBeNull();
  });

  it("ignores a number that isn't a plausible year (out of the 1900-2099 range)", () => {
    expect(extractNarrativeYear("I was 25 at the time.")).toBeNull();
  });
});

describe("clusterEpisodeMarkers — pure function, structural (boundary-window) clustering", () => {
  it("a boundary_start...boundary_end pair with an incident_reference between them clusters into ONE episode", () => {
    const markers: EpisodeMarkerEvent[] = [
      marker({ extractionEventId: "e1", sourceEventId: "m1", toldAt: "2026-01-01T00:00:00.000Z", kind: "boundary_start", text: "A falling out began." }),
      marker({ extractionEventId: "e2", sourceEventId: "m2", toldAt: "2026-01-02T00:00:00.000Z", kind: "incident_reference", text: "Still tense." }),
      marker({ extractionEventId: "e3", sourceEventId: "m3", toldAt: "2026-01-03T00:00:00.000Z", kind: "boundary_end", text: "We made up." })
    ];
    const episodes = clusterEpisodeMarkers(markers);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.title).toBe("A falling out began.");
    expect(episodes[0]!.told_start).toBe("2026-01-01T00:00:00.000Z");
    expect(episodes[0]!.told_end).toBe("2026-01-03T00:00:00.000Z");
    expect(JSON.parse(episodes[0]!.source_event_ids)).toEqual(["e1", "e2", "e3", "m1", "m2", "m3"].sort());
  });

  it("an incident_reference with no open boundary is its own standalone one-marker episode", () => {
    const markers: EpisodeMarkerEvent[] = [marker({ extractionEventId: "e1", sourceEventId: "m1", toldAt: "2026-01-01T00:00:00.000Z", kind: "incident_reference", text: "A one-off thing happened." })];
    const episodes = clusterEpisodeMarkers(markers);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.told_start).toBe(episodes[0]!.told_end);
  });

  it("two separate boundary_start...boundary_end pairs produce two separate episodes, never merged", () => {
    const markers: EpisodeMarkerEvent[] = [
      marker({ extractionEventId: "e1", sourceEventId: "m1", toldAt: "2026-01-01T00:00:00.000Z", kind: "boundary_start", text: "First incident begins." }),
      marker({ extractionEventId: "e2", sourceEventId: "m2", toldAt: "2026-01-02T00:00:00.000Z", kind: "boundary_end", text: "First incident ends." }),
      marker({ extractionEventId: "e3", sourceEventId: "m3", toldAt: "2026-01-05T00:00:00.000Z", kind: "boundary_start", text: "Second, unrelated incident begins." }),
      marker({ extractionEventId: "e4", sourceEventId: "m4", toldAt: "2026-01-06T00:00:00.000Z", kind: "boundary_end", text: "Second incident ends." })
    ];
    const episodes = clusterEpisodeMarkers(markers);
    expect(episodes).toHaveLength(2);
    expect(episodes.map((e) => e.title)).toEqual(["First incident begins.", "Second, unrelated incident begins."]);
  });

  it("a boundary_start with no matching boundary_end anywhere still closes at the end of the history (trailing open episode)", () => {
    const markers: EpisodeMarkerEvent[] = [
      marker({ extractionEventId: "e1", sourceEventId: "m1", toldAt: "2026-01-01T00:00:00.000Z", kind: "boundary_start", text: "An ongoing thing begins." }),
      marker({ extractionEventId: "e2", sourceEventId: "m2", toldAt: "2026-01-02T00:00:00.000Z", kind: "incident_reference", text: "Still ongoing." })
    ];
    const episodes = clusterEpisodeMarkers(markers);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.told_end).toBe("2026-01-02T00:00:00.000Z");
  });

  it("a NEW boundary_start closes any still-open episode first, rather than merging into it", () => {
    const markers: EpisodeMarkerEvent[] = [
      marker({ extractionEventId: "e1", sourceEventId: "m1", toldAt: "2026-01-01T00:00:00.000Z", kind: "boundary_start", text: "First, never explicitly closed." }),
      marker({ extractionEventId: "e2", sourceEventId: "m2", toldAt: "2026-01-05T00:00:00.000Z", kind: "boundary_start", text: "A second, different incident begins." })
    ];
    const episodes = clusterEpisodeMarkers(markers);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]!.title).toBe("First, never explicitly closed.");
    expect(episodes[1]!.title).toBe("A second, different incident begins.");
  });

  it("narrativeYear is taken from the first marker in the cluster that states one explicitly", () => {
    const markers: EpisodeMarkerEvent[] = [
      marker({ extractionEventId: "e1", sourceEventId: "m1", toldAt: "2026-01-01T00:00:00.000Z", kind: "boundary_start", text: "It started." }), // no year here
      marker({ extractionEventId: "e2", sourceEventId: "m2", toldAt: "2026-01-02T00:00:00.000Z", kind: "incident_reference", text: "This all traces back to 1995." }),
      marker({ extractionEventId: "e3", sourceEventId: "m3", toldAt: "2026-01-03T00:00:00.000Z", kind: "boundary_end", text: "It ended." })
    ];
    const episodes = clusterEpisodeMarkers(markers);
    expect(episodes[0]!.narrative_year).toBe("1995");
  });

  it("participant entity ids across every marker in the cluster are unioned", () => {
    const markers: EpisodeMarkerEvent[] = [
      marker({ extractionEventId: "e1", sourceEventId: "m1", toldAt: "2026-01-01T00:00:00.000Z", kind: "boundary_start", text: "Started.", participantEntityIds: ["alice"] }),
      marker({ extractionEventId: "e2", sourceEventId: "m2", toldAt: "2026-01-02T00:00:00.000Z", kind: "boundary_end", text: "Ended.", participantEntityIds: ["bob"] })
    ];
    const episodes = clusterEpisodeMarkers(markers);
    expect(JSON.parse(episodes[0]!.participant_entity_ids)).toEqual(["alice", "bob"]);
  });

  it("an empty marker list produces no episodes", () => {
    expect(clusterEpisodeMarkers([])).toEqual([]);
  });
});

describe("episode clustering, end-to-end through rebuild (EN-037 Phase 8.5)", () => {
  let eventLog: EventLog;
  let projections: ProjectionsDb;

  beforeEach(() => {
    eventLog = new EventLog(freshTestDbPath(import.meta.url, "events"));
    projections = new ProjectionsDb(freshTestDbPath(import.meta.url, "projections"));
  });

  function appendExtraction(sourceEventId: string, payload: Record<string, unknown>) {
    return eventLog.append({
      type: "extraction_completed",
      actor: "system",
      payload: { sourceEventId, extractorVersion: "message-v1", entities: [], structuralAtoms: [], socialBonds: [], attributes: [], episodeMarkers: [], ...payload },
      userId: PRIMARY_USER_ID
    });
  }

  it("rebuildProjections reports episodesBuilt and writes real rows to the episodes table, no new extraction schema field needed", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Back in 1995 my sister and I had a huge fight." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg.id, {
      entities: [{ name: "Elena", type: "person" }],
      episodeMarkers: [{ kind: "incident_reference", text: "A huge fight with Elena, back in 1995." }]
    });

    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(result.episodesBuilt).toBe(1);
    const episodes = projections.listEpisodesByNarrativeOrder(PRIMARY_USER_ID);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.narrative_year).toBe("1995");
    const elena = projections.listEntities(PRIMARY_USER_ID).find((e) => e.name === "Elena")!;
    expect(JSON.parse(episodes[0]!.participant_entity_ids)).toContain(elena.id);
  });

  it("listEpisodesByNarrativeOrder sorts by the real narrative year, not by system/insertion order — a later-inserted but earlier-dated episode sorts FIRST", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Recent thing." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { episodeMarkers: [{ kind: "incident_reference", text: "Something happened in 2020." }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Older thing, mentioned later." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { episodeMarkers: [{ kind: "incident_reference", text: "Something else happened back in 1990." }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const episodes = projections.listEpisodesByNarrativeOrder(PRIMARY_USER_ID);
    expect(episodes.map((e) => e.narrative_year)).toEqual(["1990", "2020"]);
  });

  it("an undated episode sorts AFTER every dated one, ordered among other undated episodes by told_start", () => {
    const msg1 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "No date given." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg1.id, { episodeMarkers: [{ kind: "incident_reference", text: "Something happened, no year mentioned." }] });
    const msg2 = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Dated thing." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg2.id, { episodeMarkers: [{ kind: "incident_reference", text: "Something happened in 2015." }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    const episodes = projections.listEpisodesByNarrativeOrder(PRIMARY_USER_ID);
    expect(episodes.map((e) => e.narrative_year)).toEqual(["2015", null]);
  });

  it("a full rebuild wipes and correctly re-derives episodes, never accumulating duplicates across repeated rebuilds (EN-054)", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Something happened." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg.id, { episodeMarkers: [{ kind: "incident_reference", text: "A one-off thing." }] });

    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);
    rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(projections.listEpisodesByNarrativeOrder(PRIMARY_USER_ID)).toHaveLength(1);
  });

  it("a message with no episodeMarkers at all produces no episodes", () => {
    const msg = eventLog.append({ type: "message_sent", actor: "user", payload: { text: "Just an ordinary update." }, userId: PRIMARY_USER_ID });
    appendExtraction(msg.id, {});

    const result = rebuildProjections(eventLog.listForUser(PRIMARY_USER_ID), projections, PRIMARY_USER_ID);

    expect(result.episodesBuilt).toBe(0);
    expect(projections.listEpisodesByNarrativeOrder(PRIMARY_USER_ID)).toEqual([]);
  });
});
