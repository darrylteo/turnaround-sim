# Sources

Every number in `data/` comes from one of the public documents below. We copy
facts only (durations, rates, distances). No figures, drawings or text are
reproduced. The stand, its road graph and all traffic are fictional.

| ID | Document | Used for |
|----|----------|----------|
| `AC-A320` | Airbus, *Aircraft Characteristics – Airport and Maintenance Planning (AC), A320*, Rev. 46, 1 Jul 2026. Listed on the [Airbus AC page](https://aircraft.airbus.com/en/customer-care/fleet-wide-care/airport-operations-and-aircraft-characteristics/aircraft-characteristics); [PDF](https://mediaassets.airbus.com/pm_38_916_916266-iujedqawwy.pdf?fileName=aca32001-jul-2026-2.pdf) | Primary source. §5-2-0 full-servicing turn-round chart and assumptions; §5-1-1/5-1-3 GSE types and gate ramp layout; §2-7-0 door locations; §5-4-x service connection positions; §2-2-0 general dimensions |
| `ACAP-737NG` | Boeing, *737 Airplane Characteristics for Airport Planning*, D6-58325-7 Rev. C, Oct 2025 (737-600/-700/-800/-900). Listed on [Boeing airport planning manuals](https://www.boeing.com/commercial/airports/plan-manuals); [PDF](https://www.boeing.com/content/dam/boeing/v2/airports/acaps/737NG_REV_C.pdf) | Cross-check. §5.2.4 737-800 turnaround station chart; §5.1.4 737-800 servicing arrangement |

We didn't need a textbook: both manuals state their assumptions (passenger
counts, rates and equipment) clearly enough to rebuild each task duration.

## How values were read

- Durations that the manuals state as rates were computed from those rates,
  for example 150 pax ÷ 20 pax/min = 7.5 min to deplane.
- Bar start and end times were read off the charts to about ±0.3 min.
  `data/` marks those values `"read": "chart"`.
- The A320 chart's bulk-hold row has no bar. We derived bulk timings from the
  stated rates (500 kg at 150 kg/min unloading and 120 kg/min loading) and
  marked them `"read": "derived"`.
