import { useEffect, useState } from "react";
import type { ClockPreference, DesktopPreferences } from "../desktop-preferences";
import { formatClockTime, formatPrimaryDate } from "../desktop-preferences";
import type { WeatherCurrentStatus } from "../../shared/ipc-contract";

interface CommandHeaderProps {
  preferences: DesktopPreferences;
  weather: WeatherCurrentStatus;
  weatherLoading?: boolean;
}

function Clock({ clock, now }: { clock: ClockPreference; now: Date }) {
  return <div className="command-clock" data-time-zone={clock.timeZone}>
    <span>{clock.label}</span><strong>{formatClockTime(now, clock.timeZone)}</strong>
  </div>;
}

function weatherGlyph(condition: string | null): string {
  const value = condition?.toLocaleLowerCase("es") ?? "";
  if (/tormenta|granizo/u.test(value)) return "ϟ";
  if (/nieve/u.test(value)) return "❄";
  if (/lluvia|llovizna|chubasco/u.test(value)) return "☂";
  if (/niebla/u.test(value)) return "◌";
  if (/nublado|nube/u.test(value)) return "☁";
  if (/despejado|sol/u.test(value)) return "☼";
  return "◇";
}

export function CommandHeader({ preferences, weather, weatherLoading = false }: CommandHeaderProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    const update = () => setNow(new Date());
    const initialDelay = 60_000 - (Date.now() % 60_000);
    timer = setTimeout(() => {
      update();
      interval = setInterval(update, 60_000);
    }, initialDelay);
    return () => { if (timer) clearTimeout(timer); if (interval) clearInterval(interval); };
  }, []);

  const primaryDate = formatPrimaryDate(now, preferences.primaryTimeZone);
  const city = weather.available ? weather.location : preferences.weatherLocation;
  return (
    <header className="workspace-header" aria-label="Nexa Command Center">
      <div className="command-header-left" aria-label="Core, fecha y clima">
        <div className="nexa-core-mark" aria-hidden="true">
          <span className="nexa-core-mark__orbit nexa-core-mark__orbit--one" />
          <span className="nexa-core-mark__orbit nexa-core-mark__orbit--two" />
          <span className="nexa-core-mark__ring" />
          <span className="nexa-core-mark__core" />
        </div>
        <div className="command-header-date"><strong>{primaryDate}</strong></div>
        <section className={`command-weather${weather.available ? " command-weather--available" : ""}`} aria-label="Clima actual" aria-live="polite">
          <span className="command-weather__glyph" aria-hidden="true">{weather.available ? weatherGlyph(weather.condition) : "◇"}</span>
          <div className="command-weather__copy"><span>{city}</span>
            {weather.available
              ? <><strong>{Math.round(weather.temperatureC!)}°C</strong><small>{weather.condition}</small></>
              : <strong className="command-weather__unavailable">{weatherLoading ? "Consultando clima…" : "Clima no disponible"}</strong>}
          </div>
        </section>
      </div>
      <div className="command-header-clocks" aria-label="Relojes internacionales">{preferences.clocks.map((clock) => <Clock key={clock.id} clock={clock} now={now} />)}</div>
    </header>
  );
}
