#!/bin/bash
# Private nftables >= 1.0.6 for the workspace ingress guard on bases whose
# distribution nft is older (E2B desktop: Ubuntu 22.04, nftables 1.0.2).
# Builds pinned upstream releases (verified against their published
# signatures when pinned: Netfilter Core Team 37D964ACC04981C75500FB9BD55D978A8A1420E4,
# jansson B5D6953E6D5059ED7ADA0F2FD3657D24D058434C) into one private prefix
# whose fixed absolute runpath (libtool) loads only those libraries. Needs only gcc and make: no apt, no pkg-config, no
# system headers, and no original file outside the prefix and /tmp changes.
set -euo pipefail
prefix=${1:?install prefix required}
[[ ! -e "$prefix" && ! -L "$prefix" ]] || { echo "netfilter prefix already exists" >&2; exit 3; }
work=$(mktemp -d /tmp/mikka-netfilter.XXXXXX)
trap 'rm -rf "$work"' EXIT
fetch() {
  curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 120 "$1" -o "$work/$2"
  echo "$3  $work/$2" | sha256sum --check --strict --quiet
  tar -xf "$work/$2" -C "$work"
}
fetch https://github.com/akheron/jansson/releases/download/v2.14/jansson-2.14.tar.gz jansson.tar.gz 5798d010e41cf8d76b66236cfb2f2543c8d082181d16bc3085ab49538d4b9929
fetch https://www.netfilter.org/pub/libmnl/libmnl-1.0.5.tar.bz2 libmnl.tar.bz2 274b9b919ef3152bfb3da3a13c950dd60d6e2bcd54230ffeca298d03b40d0525
fetch https://www.netfilter.org/pub/libnftnl/libnftnl-1.2.6.tar.xz libnftnl.tar.xz ceeaea2cd92147da19f13a35a7f1a4bc2767ff897e838e4b479cf54b59c777f4
fetch https://www.netfilter.org/pub/nftables/nftables-1.0.9.tar.xz nftables.tar.xz a3c304cd9ba061239ee0474f9afb938a9bb99d89b960246f66f0c3a0a85e14cd
jobs=$(nproc)
lib="$prefix/lib" inc="$prefix/include"
build() {
  (cd "$work/$1" && shift && ./configure --prefix="$prefix" --disable-static --enable-shared "$@" >/dev/null \
    && make -j"$jobs" >/dev/null && make install >/dev/null)
}
# No pkg-config on the base: give configure each dependency's flags directly.
# libtool gives the binary and every library the absolute runpath $prefix/lib,
# so libnftables, libnftnl, libmnl and jansson resolve inside the prefix.
export CPPFLAGS="-I$inc" LDFLAGS="-L$lib" PKG_CONFIG=/bin/false
build jansson-2.14
build libmnl-1.0.5
LIBMNL_CFLAGS="-I$inc" LIBMNL_LIBS="-L$lib -lmnl" build libnftnl-1.2.6
LIBMNL_CFLAGS="-I$inc" LIBMNL_LIBS="-L$lib -lmnl" LIBNFTNL_CFLAGS="-I$inc" LIBNFTNL_LIBS="-L$lib -lnftnl" \
  build nftables-1.0.9 --with-json --with-mini-gmp --without-cli --disable-man-doc --without-xtables
# Every object with a private dependency must load it from the prefix.
for object in "$prefix/sbin/nft" "$lib"/libnftables.so.*.* "$lib"/libnftnl.so.*.*; do
  readelf -d "$object" | grep -Eq "R(UN)?PATH.*\[$lib(:|\])" || { echo "missing private runpath: $object" >&2; exit 4; }
done
rm -rf "$prefix/include" "$prefix/share" "$prefix/lib/pkgconfig" "$prefix/etc"
find "$lib" -name '*.la' -delete
"$prefix/sbin/nft" --version | grep -Eq '^nftables v1\.0\.9 '
chown -R root:root "$prefix" 2>/dev/null || true
chmod -R go-w "$prefix"
