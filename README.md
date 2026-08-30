# Acrophobia forecasts

GitHub Actions operator that builds the Acrophobia forecast dataset. It runs on a schedule, builds
NOAA and ECCC weather products, and writes the results to a private Cloudflare R2 bucket.
[`azohra/acrophobia.ca`](https://github.com/azohra/acrophobia.ca) reads that bucket through its
Worker binding — the website and this publisher are separate repos on purpose.

Every 15 minutes the workflow checks each provider for a new model run, builds any launch sites
listed in the dataset's `sites.json`, publishes each completed model immediately, and updates the
dataset's `runs.json` index. The build engine is the published npm package
`@azohra/meteo.forecast`, pinned in `package.json`.

This repo only contains the workflows and the engine pin — no site data. Launch-site identity
(`sites.json` and the derived `site-context.json`) lives in the R2 bucket, not in this repo. Each
build fetches `sites.json` from the bucket at run time and fails if it's missing.

## Configuration

GitHub Actions secrets (Settings → Secrets and variables → Actions):

- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — an R2 API token scoped to the dataset bucket only
- `R2_ENDPOINT` — `https://<account-id>.r2.cloudflarestorage.com`, passed to the engine as
  `METEO_S3_ENDPOINT`

And one repository variable:

- `METEO_R2_BUCKET` — the destination bucket name

Don't set `METEO_DATA_BASE`. Without it the engine reads its own publish state through the
authenticated S3 endpoint above; setting it switches the engine to the public HTTPS path instead,
which can't see what's already published.

Forks and pull requests don't get these secrets — the workflows only run on the default branch, on
schedule, or via manual dispatch from the repo owner.

## Local validation

The workflow bodies are [mise](https://mise.jdx.dev) tasks — `mise tasks` lists them. Anything
that writes to the bucket needs the credentials above in the environment and fails with the missing
name otherwise, and a single model can be rerun alone:

```sh
mise install                 # node + pnpm
mise run build:data:gfs      # build and publish one model
mise run build:data          # the full pass
```

A credential-free smoke test that touches no bucket:

```sh
mise run install
pnpm exec meteo forecast catalogue --output data/models.json
```

`data/` is generated output and is gitignored.

## Changing a launch site

Site data lives in the bucket, not here. Add, move, or retire a launch in the acrophobia.ca admin,
which publishes the updated `sites.json`. The next scheduled run picks it up automatically
(`--sites dataset`), and the terrain job regenerates `site-context.json` whenever the site list
changes — no manual step needed on this side.

Site slugs are permanent: renaming a slug creates a new site, and the old slug's history is
retired, not carried forward.
