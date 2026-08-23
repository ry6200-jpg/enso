/**
 * Ambient context batch, item 1: current weather conditions (Google Maps
 * Platform Weather API, GA since June 2025). Real API shape verified
 * directly (two live currentConditions:lookup calls — Johor Bahru and Los
 * Angeles, both real 200s with real data) before this was written, not
 * assumed from documentation: `temperature.degrees` (Celsius by request
 * region default), `feelsLikeTemperature.degrees`, `weatherCondition.
 * description.text`. Malaysia (Johor Bahru specifically) confirmed live
 * to return real, non-empty data — coverage is real, not just documented.
 *
 * Billing confirmed (pay-as-you-go, real project credits) before this was
 * built — see the batch report.
 *
 * CORE DISTINCTION (see enso-rebuild-requirements.md and
 * src/location/currentLocation.ts): weather is true for THIS TURN ONLY.
 * Never stored, never an event, never entity_attributes, never
 * extraction input — see the ambient-context exclusion note in
 * currentLocation.ts for the full discipline this follows.
 */
const WEATHER_TIMEOUT_MS = 8000;

export interface CurrentWeather {
  temperatureCelsius: number;
  feelsLikeCelsius: number;
  description: string;
}

export async function getCurrentWeather(latitude: number, longitude: number, apiKey: string | undefined): Promise<CurrentWeather | null> {
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://weather.googleapis.com/v1/currentConditions:lookup?key=${apiKey}&location.latitude=${latitude}&location.longitude=${longitude}`, {
      signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      temperature?: { degrees?: number };
      feelsLikeTemperature?: { degrees?: number };
      weatherCondition?: { description?: { text?: string } };
    };
    const temperatureCelsius = data.temperature?.degrees;
    const feelsLikeCelsius = data.feelsLikeTemperature?.degrees;
    const description = data.weatherCondition?.description?.text;
    if (temperatureCelsius === undefined || feelsLikeCelsius === undefined || !description) return null;
    return { temperatureCelsius, feelsLikeCelsius, description };
  } catch {
    return null;
  }
}
