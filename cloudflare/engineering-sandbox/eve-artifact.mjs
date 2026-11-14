const sha256 = /^[0-9a-f]{64}$/;
const maximumSize = 512 * 1024 * 1024;

export function approvedEveBuild(job, env) {
  if (
    !env.EVE_BUILD_ARTIFACTS ||
    job.sha !== env.EVE_BUILD_REVISION ||
    typeof env.EVE_BUILD_SOURCE_SHA256 !== "string" ||
    !sha256.test(env.EVE_BUILD_SOURCE_SHA256)
  ) {
    throw new Error(
      "Eve qualification requires the approved source and an artifact bucket",
    );
  }
  if (
    typeof job.owner !== "string" ||
    !/^[1-9][0-9]{0,19}\/[1-9][0-9]{0,5}\/eve-host-build$/.test(job.owner)
  ) {
    throw new Error("Invalid engineering build owner");
  }
  const [runId, attempt] = job.owner.split("/");
  return {
    sha: job.sha,
    sourceDigest: env.EVE_BUILD_SOURCE_SHA256,
    runId,
    attempt,
  };
}

export async function retainEveArtifact(
  container,
  bucket,
  job,
  artifact,
  remember,
) {
  if (
    !Number.isSafeInteger(artifact?.size) ||
    artifact.size < 1 ||
    artifact.size > maximumSize ||
    typeof artifact.sha256 !== "string" ||
    !sha256.test(artifact.sha256) ||
    artifact.manifest?.sourceSha !== job.sha ||
    typeof artifact.manifest?.releaseId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/.test(artifact.manifest.releaseId)
  ) {
    throw new Error("Invalid compiled Eve archive");
  }
  const key =
    "engineering/eve/" +
    job.owner +
    "/" +
    job.sha +
    "/" +
    artifact.sha256 +
    ".tar.gz";
  // Workers/R2 require a stream with a known size. R2 additionally verifies
  // its payload checksum, independently of the VM's file digest.
  await remember(key);
  const pipe = new FixedLengthStream(artifact.size);
  const reader = await container.exec(["/bin/cat", "/tmp/eve-host.tar.gz"], {
    stdout: "pipe",
  });
  const [saved] = await Promise.all([
    bucket.put(key, pipe.readable, {
      sha256: artifact.sha256,
      httpMetadata: { contentType: "application/gzip" },
    }),
    reader.stdout.pipeTo(pipe.writable),
  ]);
  if (!saved || saved.size !== artifact.size)
    throw new Error("Compiled Eve archive was not retained");
  return {
    key,
    size: saved.size,
    sha256: artifact.sha256,
    releaseId: artifact.manifest.releaseId,
  };
}

// The verification VM has no network and starts only after the compiler stops.
// Its filesystem is reconstructed exclusively from the R2 object accepted above.
export async function verifyEveArtifact(
  container,
  bucket,
  artifact,
  probe,
  source,
  release,
) {
  const object = await bucket.get(artifact.key);
  if (
    !object ||
    object.size !== artifact.size ||
    object.checksums.toJSON().sha256 !== artifact.sha256
  ) {
    throw new Error("Eve verification archive changed");
  }
  const write = await container.exec(
    [
      "node",
      "-e",
      `
    const { createHash } = require('node:crypto')
    const { createWriteStream } = require('node:fs')
    const hash = createHash('sha256')
    const target = createWriteStream('/tmp/host.tgz', { flags: 'wx' })
    process.stdin.on('data', chunk => hash.update(chunk)).pipe(target)
    target.on('finish', () => { if (hash.digest('hex') !== process.argv[1]) process.exitCode = 1 })
  `,
      artifact.sha256,
    ],
    { stdin: object.body },
  );
  if ((await write.output()).exitCode !== 0)
    throw new Error("Restored Eve archive digest mismatch");
  const privileges = [
    "--reuid=1000",
    "--regid=1000",
    "--clear-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--no-new-privs",
  ];
  const unpack = await container.exec([
    "/bin/sh",
    "-ec",
    'mkdir -p /app; chown 1000:1000 /app; exec "$@"',
    "unpack",
    "setpriv",
    ...privileges,
    "tar",
    "--no-same-owner",
    "-xzf",
    "/tmp/host.tgz",
    "-C",
    "/app",
  ]);
  if ((await unpack.output()).exitCode !== 0)
    throw Error("Restored Eve archive cannot be extracted");
  const child = await container.exec(
    [
      "/usr/bin/setpriv",
      ...privileges,
      "node",
      "--input-type=module",
      "-e",
      probe,
    ],
    { cwd: "/app" },
  );
  const { exitCode, stdout, stderr } = await child.output();
  if (exitCode !== 0)
    throw Error(
      "Compiled host gate: " + new TextDecoder().decode(stderr).slice(-900),
    );
  for (const line of new TextDecoder().decode(stdout).split("\n")) {
    let receipt;
    try {
      receipt = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      receipt.sourceSha === source &&
      receipt.releaseId === release &&
      receipt.unknownRelease === 409 &&
      receipt.unsigned === 403
    ) {
      return {
        sourceSha: source,
        releaseId: release,
        node: receipt.node,
        unknownRelease: 409,
        unsigned: 403,
      };
    }
  }
  throw Error(
    "Compiled Eve host did not acknowledge the bound release and unsigned delivery",
  );
}
