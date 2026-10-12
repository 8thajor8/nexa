// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DashboardModules } from "../src/renderer/components/DashboardModules";

afterEach(cleanup);

const playingStatus = {
  state: "playing" as const, connected: true, deviceAvailable: true, controlsEnabled: true,
  track: { name: "A Very Long Song Title That Must Not Push Controls", artists: ["An Artist With A Long Name"],
    imageUrl: "https://i.scdn.co/image/test", spotifyUrl: "https://open.spotify.com/track/abc123", playing: true },
  message: null, updatedAt: 1,
};

describe("Spotify mini-player", () => {
  it("keeps artwork, stacked track metadata, and accessible controls in one horizontal row", () => {
    const onControl = vi.fn();
    render(createElement(DashboardModules, { assistantState: "En espera", spotifyStatus: playingStatus,
      onSpotifyControl: onControl, onOpenSpotifyTrack: vi.fn() }));

    const player = screen.getByRole("region", { name: "Reproductor de Spotify" });
    const children = Array.from(player.children) as HTMLElement[];
    expect(children.map((child) => child.className)).toEqual([
      "spotify-mini-player__artwork", "spotify-mini-player__meta", "spotify-mini-player__controls",
    ]);
    expect(screen.getByText(playingStatus.track.name)).toBeTruthy();
    expect(screen.getByText(playingStatus.track.artists[0])).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pausar Spotify" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pista anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Pausar Spotify" }));
    fireEvent.click(screen.getByRole("button", { name: "Pista siguiente" }));
    expect(onControl.mock.calls).toEqual([["previous"], ["pause"], ["next"]]);
  });

  it("keeps a readable actionable error and preserves touch and narrow-width rules", () => {
    render(createElement(DashboardModules, { assistantState: "En espera", spotifyStatus: playingStatus,
      spotifyError: "Spotify no confirmó la acción. No se repetirá automáticamente." }));
    const player = screen.getByRole("region", { name: "Reproductor de Spotify" });
    expect(player.querySelector(".spotify-mini-player__notice")?.textContent).toContain("no confirmó la acción");
    const css = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");
    expect(css).toMatch(/\.spotify-mini-player\s*\{[^}]*grid-template-columns:\s*48px minmax\(0, 1fr\) auto/s);
    expect(css).toMatch(/\.spotify-mini-player__controls button\s*\{[^}]*min-width:\s*44px[^}]*height:\s*44px/s);
    expect(css).toMatch(/@container\s*\(max-width:\s*380px\)/);
    expect(css).toMatch(/\.spotify-mini-player__notice\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/\.spotify-mini-player\s*\{[^}]*grid-template-areas:\s*"art meta controls"/s);
    expect(css).not.toMatch(/grid-template-areas:[^;]*notice notice notice/);
  });

  it("renders no warning row when only compatible playback state is observed", () => {
    render(createElement(DashboardModules, { assistantState: "En espera", spotifyStatus: playingStatus, spotifyError: null }));
    const player = screen.getByRole("region", { name: "Reproductor de Spotify" });
    expect(player.querySelector(".spotify-mini-player__notice")).toBeNull();
    expect(player.querySelector(".spotify-mini-player__controls")).toBeTruthy();
    expect(screen.getByText(playingStatus.track.name)).toBeTruthy();
  });

  it("keeps playback buttons disabled when the provider has no usable device", () => {
    render(createElement(DashboardModules, { assistantState: "En espera", spotifyStatus: {
      ...playingStatus, state: "no_device", deviceAvailable: false, controlsEnabled: false,
      track: null, message: "No hay dispositivo Spotify.",
    } }));
    expect((screen.getByRole("button", { name: "Pista anterior" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reanudar Spotify" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Pista siguiente" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
