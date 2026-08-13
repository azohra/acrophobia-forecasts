#!/bin/sh
# Uploads one model's freshly built outputs from the scratch data/ tree to
# the private dataset bucket. Called after every model build so a completed
# model is published even if a later builder or the job's timeout kills the
# run.
#
# Requires AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ENDPOINT in the
# environment (the workflow maps them from repo secrets) and METEO_R2_BUCKET
# (mapped from a repo variable). The catalogues are deliberately absent
# here: they publish only from publish-catalogues.yml, so racing model
# uploads can never stomp them.
set -eu

model="$1"
: "${METEO_R2_BUCKET:?METEO_R2_BUCKET must name the private dataset bucket}"
: "${R2_ENDPOINT:?R2_ENDPOINT must be the R2 S3 endpoint URL}"
bucket="s3://${METEO_R2_BUCKET}"
# Everything that changes with the next run rides a short TTL; only month
# archives that can no longer receive an append are immutable.
short="public, max-age=300"
closed="public, max-age=31536000, immutable"

s3() {
  aws s3 "$@" --endpoint-url "$R2_ENDPOINT"
}

# The builder writes nothing when the published run is current, so an
# absent manifest means there is nothing new to upload for this model.
if [ ! -f "data/$model/manifest.json" ]; then
  echo "No new $model output to upload."
  exit 0
fi

# Never publish backwards: a scratch tree older than the published dataset
# (a stale checkout, a replayed job) must not overwrite newer objects. The
# engine reads the published manifest through the authenticated S3 path
# (the credential trio is present and METEO_DATA_BASE is never set) and
# prints fresh or stale; it exits nonzero only on a transport failure,
# which set -e turns into a loud script failure — an unreachable bucket
# must never read as either verdict.
freshness=$(pnpm exec meteo forecast freshness --model "$model" --manifest "data/$model/manifest.json")
case $freshness in
  fresh) ;;
  stale)
    echo "Published $model manifest is not older than the local one; skipping upload."
    exit 0
    ;;
  *)
    echo "Unexpected freshness verdict for $model: '$freshness'." >&2
    exit 1
    ;;
esac

# Month archives close when no run with a referenceTime in that month can
# still arrive. A run started just before a month boundary appends to the
# previous month after it, so the previous month stays on the short TTL
# too; anything older is genuinely closed.
open_months=$(node -e "
const now = new Date();
const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const previous = new Date(first.getTime() - 86400000);
const month = (d) => d.toISOString().slice(0, 7);
console.log(month(first) + ' ' + month(previous));
")
current_month=${open_months% *}
previous_month=${open_months#* }

# History before profiles before the manifest: the manifest is the
# publication's commit point, so nothing it references appears after it.
#
# Each month's sidecar byte-offset index (*.index.json) syncs beside its
# archive and follows the same open/closed TTL arithmetic. The index
# months are named explicitly in their own passes: an
# everything-but-the-open-months second pass would sweep an open month's
# index onto the immutable TTL — a year of CDN staleness for the one file
# whose job is to say what the archive holds right now.
if [ -d "data/$model/history" ]; then
  s3 sync "data/$model/history" "$bucket/$model/history" \
    --exclude "*" \
    --include "*/${current_month}.jsonl.gz" --include "*/${previous_month}.jsonl.gz" \
    --cache-control "$short" --content-type application/gzip
  s3 sync "data/$model/history" "$bucket/$model/history" \
    --exclude "*" \
    --include "*/${current_month}.index.json" --include "*/${previous_month}.index.json" \
    --cache-control "$short" --content-type application/json
  s3 sync "data/$model/history" "$bucket/$model/history" \
    --exclude "*" --include "*.jsonl.gz" \
    --exclude "*/${current_month}.jsonl.gz" --exclude "*/${previous_month}.jsonl.gz" \
    --cache-control "$closed" --content-type application/gzip
  s3 sync "data/$model/history" "$bucket/$model/history" \
    --exclude "*" --include "*.index.json" \
    --exclude "*/${current_month}.index.json" --exclude "*/${previous_month}.index.json" \
    --cache-control "$closed" --content-type application/json
fi
s3 sync "data/$model/sites" "$bucket/$model/sites" \
  --cache-control "$short" --content-type application/json
s3 cp "data/$model/manifest.json" "$bucket/$model/manifest.json" \
  --cache-control "$short" --content-type application/json

# runs.json is regenerated from every model's *published* manifest (model
# list from the engine's catalogue, never-published models tolerated), so
# the index is a pure function of the dataset and concurrent lanes converge
# on whoever uploads last; a stale write self-heals on the next model
# upload.
pnpm exec meteo forecast runs-index --output data/runs.json
s3 cp data/runs.json "$bucket/runs.json" \
  --cache-control "$short" --content-type application/json
