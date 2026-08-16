# Acrophobia forecasts

Public GitHub Actions operator for the Acrophobia forecast dataset. The website and this publisher
are deliberately separate: this repository builds forecast documents and writes them to a private
Cloudflare R2 bucket; [`azohra/acrophobia.ca`](https://github.com/azohra/acrophobia.ca) reads that
bucket through its Worker binding.

The scheduled workflow checks providers every 15 minutes. It builds NOAA and ECCC products for the
four launches in `catalog/sites.json`, publishes each completed model immediately, and advances the
dataset's `runs.json` index. The engine is the pinned public npm package
`@azohra/meteo.forecast`.

## Repository configuration

The dataset remains private even though this operator is public. GitHub Actions uses these encrypted
repository secrets:

- `R2_ACCESS_KEY_ID`: access key for an R2 Object Read & Write token scoped only to the dataset bucket
- `R2_SECRET_ACCESS_KEY`: the corresponding secret access key
- `R2_ENDPOINT`: `https://<account-id>.r2.cloudflarestorage.com`

The `METEO_R2_BUCKET` repository variable names the destination bucket. Never add
`METEO_DATA_BASE`: builders must read publication state through the authenticated S3-compatible
endpoint.

Fork and pull-request workflows do not receive the repository secrets. The publishing workflows run
only from the default branch, a schedule, or an explicit owner dispatch.

## Local validation

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec meteo forecast catalogue --output models.json
```

Generated model data belongs in `data/` and is intentionally ignored.

## Adding a launch

Edit `catalog/sites.json`, then regenerate and commit the terrain context:

```sh
pnpm exec meteo forecast terrain \
  --sites catalog/sites.json \
  --output catalog/site-context.json
```
