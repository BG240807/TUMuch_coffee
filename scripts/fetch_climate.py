# Precompute monthly climate values for Heilbronn -> data/climate-months.json (used by time-slider.js).
#   measured  (2020-01 .. last complete month): Open-Meteo archive (ERA5) + air quality (CAMS)
#   projected (next month .. 2050-12): average of 7 CMIP6 HighResMIP models, same month over Y-5..Y+5,
#   each model bias-corrected per calendar month against measured 2021-2025 (temperatures shifted,
#   precipitation scaled) before counting hot days, tropical nights and heavy-rain days
# Run once: python3 scripts/fetch_climate.py   (stdlib only, ~20 min because of Open-Meteo's rate limits;
# raw downloads are cached in ~/.cache/greencity-climate, so reruns are instant)
import datetime, hashlib, json, os, time, urllib.error, urllib.parse, urllib.request

LAT, LON = 49.142, 9.219
MODELS = ['CMCC_CM2_VHR4', 'FGOALS_f3_H', 'HiRAM_SIT_HR', 'MRI_AGCM3_2_S', 'EC_Earth3P_HR', 'MPI_ESM1_2_XR', 'NICAM16_8S']
DAILY = 'temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_mean,wind_speed_10m_mean'
FIRST_YEAR, PROJ_FIRST, PROJ_LAST, WINDOW = 2020, 2021, 2050, 5
BIAS_YEARS = ('2021', '2025')  # overlap of measured history and model runs used for the correction
CACHE = os.path.expanduser('~/.cache/greencity-climate')
PAUSE = 70  # s between big requests: each costs ~470 of the 600 weighted calls per minute

today = datetime.date.today()
this_month = (today.year, today.month)


def get(base, pause=0, **params):
    url = base + '?' + urllib.parse.urlencode({'latitude': LAT, 'longitude': LON, 'timezone': 'Europe/Berlin', **params})
    cached = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest() + '.json')
    if os.path.exists(cached):
        with open(cached) as f:
            return json.load(f)
    time.sleep(pause)
    for attempt in range(12):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = json.load(r)
            os.makedirs(CACHE, exist_ok=True)
            with open(cached, 'w') as f:
                json.dump(data, f)
            return data
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            reason = e.read().decode(errors='replace')
            wait = 65 if 'Minutely' in reason else 600  # hourly limit: wait longer
            print(f'  rate limited ({reason[:60]}), waiting {wait} s ...', flush=True)
            time.sleep(wait)
    raise RuntimeError('still rate limited: ' + url)


def mean(v):
    v = [x for x in v if x is not None]
    return sum(v) / len(v) if v else None


def r1(x):
    return None if x is None else round(x, 1)


def month_stats(days, d, suffix=''):
    """days: indices of one month in the daily dict d (columns optionally suffixed per model). None if no data."""
    col = lambda v: [d[v + suffix][k] for k in days if d[v + suffix][k] is not None]
    tm = col('temperature_2m_mean')
    if not tm:
        return None
    tx, tn, rr = col('temperature_2m_max'), col('temperature_2m_min'), col('precipitation_sum')
    return {'t': mean(tm), 'tx': mean(tx),
            'hd': sum(t >= 30 for t in tx),  # hot days
            'tn': sum(t >= 20 for t in tn),  # tropical nights (minimum stays >= 20 °C)
            'hr': sum(r >= 20 for r in rr),  # heavy-rain days (>= 20 mm)
            'r': sum(rr) if len(rr) == len(days) else None,
            'h': mean(col('relative_humidity_2m_mean')), 'w': mean(col('wind_speed_10m_mean'))}


def bias_correct(c, era5):
    """Correct one model's daily data in place, per calendar month, against measured ERA5 over BIAS_YEARS."""
    def monthly(d, v, how):
        out = {}
        for ym, days in group_by_month(d['time']).items():
            if BIAS_YEARS[0] <= ym[:4] <= BIAS_YEARS[1]:
                vals = [d[v][k] for k in days if d[v][k] is not None]
                if vals:
                    out.setdefault(ym[5:], []).append(how(vals))
        return {m: sum(x) / len(x) for m, x in out.items()}
    for v in ('temperature_2m_mean', 'temperature_2m_max', 'temperature_2m_min'):
        obs, mod = monthly(era5, v, mean), monthly(c, v, mean)
        shift = {m: obs[m] - mod[m] for m in mod if m in obs}
        c[v] = [x if x is None else x + shift.get(t[5:7], 0) for t, x in zip(c['time'], c[v])]
    v = 'precipitation_sum'
    obs, mod = monthly(era5, v, sum), monthly(c, v, sum)
    factor = {m: min(2, max(0.5, obs[m] / mod[m])) for m in mod if m in obs and mod[m] > 0}
    c[v] = [x if x is None else x * factor.get(t[5:7], 1) for t, x in zip(c['time'], c[v])]


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
    s = month_stats(days, w)
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
    print(f'projection {model} ({i + 1}/{len(MODELS)})', flush=True)
    c = get('https://climate-api.open-meteo.com/v1/climate', pause=PAUSE, start_date=f'{PROJ_FIRST}-01-01',
            end_date=f'{PROJ_LAST}-12-31', models=model, daily=DAILY)['daily']
    bias_correct(c, w)
    for ym, days in group_by_month(c['time']).items():
        s = month_stats(days, c)
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
        months[f'{y}-{m:02d}'] = {'k': 'p', **{key: mean([s[key] for s in stats]) for key in ('t', 'tx', 'hd', 'tn', 'hr', 'r', 'h', 'w') if any(s[key] is not None for s in stats)}}
        n = len({md for md in MODELS for yy in window if (md, f'{yy}-{m:02d}') in per_model})
        if n < len(MODELS):  # only stored when a model is missing; the card defaults to 7
            months[f'{y}-{m:02d}']['n'] = n

# ---------- particulate matter estimate for future months ----------
# No local PM projections exist. Clayton et al. 2024 (ACP 24:10717): population-weighted PM2.5 in Europe
# falls 34 % from 2014 to 2050 under SSP2-4.5. Assuming a linear decline, 2024 is already part of the way,
# so the remaining drop from 2024 is (expected_2024 - target) / expected_2024 (~27 %), applied linearly to
# Heilbronn's measured 2023-2025 average for each calendar month (PM10 scaled the same way).
PM_DROP, PM_BASE_YEAR, PM_NOW, PM_TARGET = 0.34, 2014, 2024, 2050
expected_now = 1 - PM_DROP * (PM_NOW - PM_BASE_YEAR) / (PM_TARGET - PM_BASE_YEAR)
remaining = (expected_now - (1 - PM_DROP)) / expected_now
for ym, d in months.items():
    if d['k'] != 'p':
        continue
    y, m = int(ym[:4]), ym[5:]
    factor = 1 - remaining * (y + (int(m) - 0.5) / 12 - PM_NOW) / (PM_TARGET - PM_NOW)
    for key in ('pm25', 'pm10'):
        base = mean([months.get(f'{by}-{m}', {}).get(key) for by in (2023, 2024, 2025)])
        if base is not None:
            d[key] = base * factor
print(f'PM estimate: -{remaining:.0%} from {PM_NOW} to {PM_TARGET}')

WHOLE = ('r', 'h', 'w', 'aqi')  # shown without decimals in the card; keeps the file small
out = {
    'generated': today.isoformat(),
    'source': 'Open-Meteo: ERA5 archive, CAMS air quality, CMIP6 HighResMIP climate models (7-model mean, month averaged over +/-5 years, '
              'bias-corrected against measured 2021-2025); future PM2.5/PM10 = 2023-25 monthly average x SSP2-4.5 trend '
              '(Clayton et al. 2024, ACP 24:10717)',
    'months': {ym: {k: (round(v) if k in WHOLE else r1(v)) if isinstance(v, float) else v for k, v in d.items()}
               for ym, d in sorted(months.items())},
}
with open('data/climate-months.json', 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print(f'{len(months)} months, {time.time() - start:.0f} s')
