# Precompute monthly climate values for Heilbronn -> data/climate-months.json (used by time-slider.js).
#   measured  (2020-01 .. last complete month): Open-Meteo archive (ERA5) + air quality (CAMS)
#   projected (next month .. 2050-12): average of 7 CMIP6 HighResMIP models, same month over Y-5..Y+5
# Run once: python3 scripts/fetch_climate.py   (stdlib only, ~10 min because of Open-Meteo's rate limits)
import datetime, json, time, urllib.error, urllib.parse, urllib.request

LAT, LON = 49.142, 9.219
MODELS = ['CMCC_CM2_VHR4', 'FGOALS_f3_H', 'HiRAM_SIT_HR', 'MRI_AGCM3_2_S', 'EC_Earth3P_HR', 'MPI_ESM1_2_XR', 'NICAM16_8S']
DAILY = 'temperature_2m_mean,temperature_2m_max,precipitation_sum,relative_humidity_2m_mean'
FIRST_YEAR, PROJ_FIRST, PROJ_LAST, WINDOW = 2020, 2021, 2050, 5
PAUSE = 70  # s between big requests: each costs ~300 of the 600 weighted calls per minute

today = datetime.date.today()
this_month = (today.year, today.month)


def get(base, **params):
    url = base + '?' + urllib.parse.urlencode({'latitude': LAT, 'longitude': LON, 'timezone': 'Europe/Berlin', **params})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            print('  rate limited, waiting 65 s ...', flush=True)
            time.sleep(65)
    raise RuntimeError('still rate limited: ' + url)


def mean(v):
    v = [x for x in v if x is not None]
    return sum(v) / len(v) if v else None


def r1(x):
    return None if x is None else round(x, 1)


def month_stats(days, tmean, tmax, rain, hum):
    """days: indices of one month. Returns dict or None if no data."""
    tm = [tmean[k] for k in days if tmean[k] is not None]
    if not tm:
        return None
    tx = [tmax[k] for k in days if tmax[k] is not None]
    rr = [rain[k] for k in days if rain[k] is not None]
    return {'t': mean(tm), 'tx': mean(tx), 'hd': sum(t >= 30 for t in tx),
            'r': sum(rr) if len(rr) == len(days) else None, 'h': mean([hum[k] for k in days])}


def group_by_month(times):
    out = {}
    for k, t in enumerate(times):
        out.setdefault(t[:7], []).append(k)
    return out


months = {}
start = time.time()

# ---------- measured history ----------
last = today.replace(day=1) - datetime.timedelta(days=1)  # last day of the previous month
print(f'measured {FIRST_YEAR}-01 .. {last:%Y-%m}', flush=True)
w = get('https://archive-api.open-meteo.com/v1/archive', start_date=f'{FIRST_YEAR}-01-01', end_date=last.isoformat(), daily=DAILY)['daily']
for ym, days in group_by_month(w['time']).items():
    s = month_stats(days, w['temperature_2m_mean'], w['temperature_2m_max'], w['precipitation_sum'], w['relative_humidity_2m_mean'])
    if s:
        months[ym] = {'k': 'm', **s}

for year in range(FIRST_YEAR, last.year + 1):  # air quality, one year per request
    end = min(datetime.date(year, 12, 31), last)
    print(f'  air quality {year}', flush=True)
    try:
        a = get('https://air-quality-api.open-meteo.com/v1/air-quality', start_date=f'{year}-01-01', end_date=end.isoformat(),
                hourly='european_aqi,pm2_5,pm10')['hourly']
    except urllib.error.HTTPError as e:
        print('  no air quality for', year, e.code)
        continue
    for ym, hours in group_by_month(a['time']).items():
        if ym in months:
            for key, var in (('aqi', 'european_aqi'), ('pm25', 'pm2_5'), ('pm10', 'pm10')):
                months[ym][key] = mean([a[var][k] for k in hours])

# ---------- projection ----------
per_model = {}  # (model, 'YYYY-MM') -> stats
for i, model in enumerate(MODELS):
    time.sleep(PAUSE)
    print(f'projection {model} ({i + 1}/{len(MODELS)})', flush=True)
    c = get('https://climate-api.open-meteo.com/v1/climate', start_date=f'{PROJ_FIRST}-01-01', end_date=f'{PROJ_LAST}-12-31',
            models=model, daily=DAILY)['daily']
    for ym, days in group_by_month(c['time']).items():
        s = month_stats(days, c['temperature_2m_mean'], c['temperature_2m_max'], c['precipitation_sum'], c['relative_humidity_2m_mean'])
        if s:
            per_model[(model, ym)] = s

y, m = this_month
while (y, m) < (PROJ_LAST, 12):
    m += 1
    if m > 12:
        y, m = y + 1, 1
    window = range(max(y - WINDOW, PROJ_FIRST), min(y + WINDOW, PROJ_LAST) + 1)
    stats = [per_model[k] for k in ((md, f'{yy}-{m:02d}') for md in MODELS for yy in window) if k in per_model]
    if stats:
        months[f'{y}-{m:02d}'] = {'k': 'p', **{key: mean([s[key] for s in stats]) for key in ('t', 'tx', 'hd', 'r', 'h')},
                                  'n': len({md for md in MODELS for yy in window if (md, f'{yy}-{m:02d}') in per_model})}

out = {
    'generated': today.isoformat(),
    'source': 'Open-Meteo: ERA5 archive, CAMS air quality, CMIP6 HighResMIP climate models (7-model mean, month averaged over +/-5 years)',
    'months': {ym: {k: (r1(v) if isinstance(v, float) else v) for k, v in d.items()} for ym, d in sorted(months.items())},
}
with open('data/climate-months.json', 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print(f'{len(months)} months, {time.time() - start:.0f} s')
