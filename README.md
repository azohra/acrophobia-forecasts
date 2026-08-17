# Acrophobia forecasts

Public GitHub Actions operator for the Acrophobia forecast dataset. The website and this publisher
are deliberately separate: this repository builds forecast documents and writes them to a private
Cloudflare R2 bucket; [`azohra/acrophobia.ca`](https://github.com/azohra/acrophobia.ca) reads that
bucket through its Worker binding.

The scheduled workflow checks providers every 15 minutes. It builds NOAA and ECCC products for the
launches named by the dataset's own `sites.json`, publishes each completed model immediately, and
advances the dataset's `runs.json` index. The engine is the pinned public npm package
`@azohra/meteo.forecast`.

This repository holds mechanism only — workflows, the engine pin, and the upload script. Site
identity (`sites.json` and its derived `site-context.json`) lives at the private bucket's root,
never in this public tree: each build job fetches `sites.json` through the authenticated endpoint
before building and fails without it.

## Repository configuration

The dataset remains private even though this operator is public. GitHub Actions uses these encrypted
repository secrets:

- `R2_ACCESS_KEY_ID`: access key for an R2 Object Read & Write token scoped only to the dataset bucket
- `R2_SECRET_ACCESS_KEY`: the corresponding secret access key
- `R2_ENDPOINT`: `https://<account-id>.r2.cloudflarestorage.com` (fed to the engine as `METEO_S3_ENDPOINT`)

The `METEO_R2_BUCKET` repository variable names the destination bucket. Never add
`METEO_DATA_BASE`: builders must read publication state through the authenticated S3-compatible
endpoint.

Fork and pull-request workflows do not receive the repository secrets. The publishing workflows run
only from the default branch, a schedule, or an explicit owner dispatch.

## Local validation

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec meteo forecast catalogue --output data/models.json
```

Generated data belongs in `data/` and is intentionally ignored.

## Changing a launch

Site identity is the club's, and it never enters this repository. Launches are added, moved, and
retired in the acrophobia.ca admin, which publishes the dataset's `sites.json`; the next scheduled
tick builds from it (`--sites dataset`), and the tick's terrain job runs
`meteo forecast terrain --sync`, which regenerates and republishes `site-context.json` exactly
when the catalogue moved — no manual step remains.

Slugs are permanent identifiers: they key each model's per-site documents and the history archives,
so a renamed slug is a new site and its predecessor's history stays retired under the old name.
