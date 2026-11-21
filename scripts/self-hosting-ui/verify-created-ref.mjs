function requireCommitRef(receipt, ref, sha) {
  if (receipt?.ref !== ref || receipt.object?.type !== 'commit' || receipt.object.sha !== sha) {
    throw new Error('EVIDENCE_PUBLICATION_MISMATCH')
  }
}

export async function publishEvidenceRef(api, branch, sha) {
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('EVIDENCE_PUBLICATION_MISMATCH')
  const ref = `refs/heads/${branch}`
  requireCommitRef(await api('/refs', { ref, sha }), ref, sha)
  requireCommitRef(await api(`/ref/heads/${branch}`), ref, sha)
}
