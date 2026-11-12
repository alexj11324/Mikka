#!/usr/bin/env bash
# Called from a trusted workflow_run job after checking out a commit on main.
set -eu -o pipefail
repo=alexj11324/Mikka
image=ghcr.io/alexj11324/mikka
version_file=config/self-hosted-stable-version
if [[ "$TRIGGER_BRANCH" == main ]]; then
  if git diff --quiet "$SOURCE_SHA^1" "$SOURCE_SHA" -- "$version_file"; then exit 0; fi
  tag=$(cat "$version_file")
  image_branch=main
else
  tag=$TRIGGER_BRANCH
  image_branch=$tag
fi
[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'SELF_HOSTED_UPDATE_RELEASE_NOT_STABLE'; exit 1; }
runs="repos/$repo/actions/workflows"
# Both independent completions trigger this gate. A missing/running lane exits
# without mutation; its completion evaluates both again. Failed lanes cannot publish.
run_for() {
  gh api -X GET "$runs/$1/runs" -f event=push -f branch="$2" -f head_sha="$SOURCE_SHA" -f per_page=10 |
    jq -c --arg sha "$SOURCE_SHA" --arg branch "$2" '[.workflow_runs[] | select(.head_sha == $sha and .head_branch == $branch and .event == "push")] | max_by(.run_number)'
}
ci=$(run_for ui-policy.yml main)
build=$(run_for self-hosted-image.yml "$image_branch")
for run in "$ci" "$build"; do
  if [[ $(jq -r '.status' <<< "$run") != completed ]]; then echo "Waiting for the other workflow to complete on $SOURCE_SHA"; exit 0; fi
  [[ $(jq -r '.conclusion' <<< "$run") == success ]] || { echo 'SELF_HOSTED_UPDATE_RELEASE_CHECK_FAILED'; exit 1; }
done
run_id=$(jq -er '.id' <<< "$build")
attempt=$(jq -er '.run_attempt' <<< "$build")
gh api "repos/$repo/actions/runs/$run_id/attempts/$attempt/jobs?per_page=100" |
  jq -e --arg sha "$SOURCE_SHA" 'any(.jobs[]; .name == "image" and .head_sha == $sha and .conclusion == "success")' >/dev/null ||
  { echo 'SELF_HOSTED_UPDATE_IMAGE_ACCEPTANCE_REQUIRED'; exit 1; }

printf '%s' "$GH_TOKEN" | skopeo login ghcr.io --username "$GITHUB_ACTOR" --password-stdin >/dev/null
read_digest() { skopeo inspect --format '{{.Digest}}' "docker://$1"; }
receipt="$image:ci-$run_id-$attempt"
digest=$(read_digest "$receipt")
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ && $(read_digest "$image:$SOURCE_SHA") == "$digest" ]] ||
  { echo 'SELF_HOSTED_UPDATE_RELEASE_DIGEST_MISMATCH'; exit 1; }
pin="$image@$digest"
revision=$(skopeo inspect --config "docker://$pin" | jq -er '.config.Labels["org.opencontainers.image.revision"]')
[[ "$revision" == "$SOURCE_SHA" ]] || { echo 'SELF_HOSTED_UPDATE_RELEASE_IMAGE_MISMATCH'; exit 1; }
fp=$(node scripts/self-hosted-update-policy.mjs migrations-hash)
marker="<!-- mikka-self-hosted-release-v2 sha=$SOURCE_SHA digest=$digest migrations=$fp protocol=0-1 -->"
if git show-ref --verify --quiet "refs/tags/$tag"; then
  [[ $(git rev-parse "refs/tags/$tag^{commit}") == "$SOURCE_SHA" ]] ||
    { echo 'SELF_HOSTED_UPDATE_RELEASE_TAG_SHA_MISMATCH'; exit 1; }
else
  [[ "$TRIGGER_BRANCH" == main ]] || { echo 'SELF_HOSTED_UPDATE_RELEASE_TAG_MISSING'; exit 1; }
  git tag "$tag" "$SOURCE_SHA"
  git push origin "refs/tags/$tag:refs/tags/$tag"
fi
if gh api "repos/$repo/releases/tags/$tag" > "$RUNNER_TEMP/existing-release.json" 2> "$RUNNER_TEMP/release-status"; then
  jq -e --arg marker "$marker" '.draft == false and .prerelease == false and (.body | split("\n") | index($marker) != null)' "$RUNNER_TEMP/existing-release.json" >/dev/null ||
    { echo 'SELF_HOSTED_UPDATE_RELEASE_ALREADY_PUBLISHED_DIFFERENT'; exit 1; }
  [[ $(read_digest "$image:$tag") == "$digest" ]] || { echo 'SELF_HOSTED_UPDATE_RELEASE_DIGEST_MISMATCH'; exit 1; }
else
  grep -Fq '(HTTP 404)' "$RUNNER_TEMP/release-status" || { cat "$RUNNER_TEMP/release-status" >&2; exit 1; }
  tags=$(skopeo list-tags "docker://$image")
  if jq -e --arg tag "$tag" '.Tags | index($tag) != null' <<< "$tags" >/dev/null; then
    [[ $(read_digest "$image:$tag") == "$digest" ]] || { echo 'SELF_HOSTED_UPDATE_RELEASE_TAG_ALREADY_POINTS_ELSEWHERE'; exit 1; }
  fi
  skopeo copy --preserve-digests "docker://$pin" "docker://$image:$tag"
  [[ $(read_digest "$image:$tag") == "$digest" ]] || { echo 'SELF_HOSTED_UPDATE_RELEASE_DIGEST_MISMATCH'; exit 1; }
  printf '%s\n\n%s\n\n%s\n' "$marker" "Tested server image: \`$pin\`." "Release: https://github.com/$repo/releases/tag/$tag — Review the [upgrade guide](https://github.com/$repo/blob/$SOURCE_SHA/docs/self-hosted-updates.md) before applying." > "$RUNNER_TEMP/self-hosted-release-notes.md"
  gh release create "$tag" --verify-tag --latest=false --title "Mikka self-hosted $tag" --notes-file "$RUNNER_TEMP/self-hosted-release-notes.md"
fi
printf 'tag=%s\ndigest=%s\n' "$tag" "$digest" >> "$GITHUB_OUTPUT"
printf 'Stable **%s** • commit `%s` • image `%s` • [image acceptance](https://github.com/%s/actions/runs/%s/attempts/%s)\n' "$tag" "$SOURCE_SHA" "$pin" "$repo" "$run_id" "$attempt" >> "$GITHUB_STEP_SUMMARY"
