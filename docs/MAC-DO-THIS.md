# Mac: authorize the Windows PC's deploy key on the OMR box (do this, then you're done)

The Windows GPU PC made its own SSH key and committed the **public** half to this repo
(`docs/windows-pc-omr.pub`). This Mac already has `~/.ssh/oci_omr`, which can log into the
cx33 worker. So this Mac just has to append the Windows public key to the box's
`authorized_keys`. That's the whole job.

## Run this (from the repo root on the Mac)

```bash
git pull
ssh -i ~/.ssh/oci_omr root@91.98.116.201 \
  "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys" < docs/windows-pc-omr.pub
```

## Confirm it worked (optional)

```bash
ssh -i ~/.ssh/oci_omr root@91.98.116.201 \
  "grep -c claude-deploy-cx33 ~/.ssh/authorized_keys && echo AUTHORIZED"
```

Expected: prints `1` then `AUTHORIZED`.

That's it. The Windows PC can now `ssh -i ~/.ssh/oci_omr root@91.98.116.201` and run the
deploy. Nothing else for the Mac to do.
