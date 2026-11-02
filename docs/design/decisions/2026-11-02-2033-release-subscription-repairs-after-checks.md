# Release the current subscription repairs after checks pass

- Date: 2026-11-02
- Source: Alex in the subscription repair review: 「通过之后，你全部进行 merge，然后让他们上线 release 新版本」。
- Rule: Applies to the current subscription/settings repair release.
- Replaces: The earlier request in this conversation to monitor without merging or deploying.

Alex authorizes merging and releasing the current reviewed subscription and
settings repairs after their checks pass. This includes the independent
runtime fix in #1057 and the complete settings/recovery changes in #1056;
#1049 is covered by those changes and does not need a duplicate merge.

The production-build review page and independent reviews have been prepared.
This latest instruction authorizes proceeding with the current changes
without another screenshot-confirmation prompt; it does not claim Alex
opened or separately accepted each screenshot.

Track the production web deployment and the applicable cloud worker,
daemon, mobile and desktop releases until their actual results are known.
The requested observation interval is five minutes. A scheduling interface
that only supports hourly tasks must not be represented as a five-minute
schedule; this active release is followed directly instead.
