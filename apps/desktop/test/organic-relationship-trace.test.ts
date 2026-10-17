import { describe, expect, it, vi } from "vitest";
import { createOrganicRelationshipTraceWriter } from "../src/main/organic-relationship-trace.js";

describe("organic relationship diagnostics", () => {
  it("is silent unless explicitly enabled", () => {
    const sink = vi.fn();
    const trace = createOrganicRelationshipTraceWriter({ sink });
    expect(trace({ stage: "write", status: "created" })).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it("emits only allowlisted stage data and drops message, name, quote, prompt, payload and IDs", () => {
    const lines: string[] = [];
    const trace = createOrganicRelationshipTraceWriter({ enabled: true, sink: line => lines.push(line) });
    expect(trace({ stage: "verification", status: "approved", durationMs: 14.6, iteration: 1, turn: 3,
      permissionEnabled: true, requestId: "private-request-id", conversationId: "private-conversation-id",
      message: "Lucía es mi hermana", preferredName: "Lucía", sourceQuote: "Lucía es mi hermana",
      prompt: "private prompt", payload: { private: true } })).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[nexa-organic-relationship]");
    expect(lines[0]).not.toMatch(/Lucía|private|prompt|payload/u);
    expect(JSON.parse(lines[0].slice(lines[0].indexOf("{")))).toEqual({
      stage: "verification", status: "approved", permissionEnabled: true, turn: 3, iteration: 1, durationMs: 15,
    });
  });

  it("rejects unknown stages, statuses and error codes", () => {
    const sink = vi.fn();
    const trace = createOrganicRelationshipTraceWriter({ enabled: true, sink });
    expect(trace({ stage: "model_prompt", status: "sent", prompt: "secret" })).toBe(false);
    expect(trace({ stage: "write", status: "created", code: "private-memory-error" })).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).not.toContain("private-memory-error");
  });

  it("keeps verifier subcauses categorical and allowlisted", () => {
    const lines: string[] = [];
    const trace = createOrganicRelationshipTraceWriter({ enabled: true, sink: line => lines.push(line) });
    expect(trace({ stage: "verification", status: "malformed", code: "response_incomplete",
      response: "private response details" })).toBe(true);
    expect(trace({ stage: "verification", status: "malformed", code: "private-api-message" })).toBe(true);
    expect(JSON.parse(lines[0].slice(lines[0].indexOf("{")))).toEqual({
      stage: "verification", status: "malformed", code: "response_incomplete",
    });
    expect(lines.join(" ")).not.toContain("private");
  });

  it("keeps local candidate rejection codes without exposing the statement", () => {
    const lines: string[] = [];
    const trace = createOrganicRelationshipTraceWriter({ enabled: true, sink: line => lines.push(line) });
    expect(trace({ stage: "local_validation", status: "rejected", code: "relationship_type_invalid",
      message: "Lucía es mi hermana", preferredName: "Lucía", relationshipLabel: "hermana" })).toBe(true);
    expect(JSON.parse(lines[0].slice(lines[0].indexOf("{")))).toEqual({
      stage: "local_validation", status: "rejected", code: "relationship_type_invalid",
    });
    expect(lines[0]).not.toMatch(/Lucía|hermana|message|preferredName/u);
  });
});
