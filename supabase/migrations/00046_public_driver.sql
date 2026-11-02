/**
 * The passenger is about to get into a stranger's vehicle. Say who is driving it.
 *
 * `get_trip_public` already names the operator and the vehicle — "Toyota Hiace 2021", "Al-Noor Transport" — but not the
 * person holding the wheel, which is the one fact a passenger asks for at the door. Nothing in the payload could supply
 * it: `driver_id` was a column on `trips` that the public projection dropped.
 *
 * **A first name, not a full name.** This function is public: it is reachable by trip code from an unauthenticated
 * page, and the row it returns is cached in a browser and scraped by anything that wants it. `driver_profiles` also
 * holds an invited phone number, a licence number and a licence photo path — none of which belongs in a public
 * projection, and none of which is added here. A full name is enough to find a person in a country of thirty million;
 * a first name plus "verified" is what the passenger needs to recognise who they are meeting, and it is what every
 * ride-hailing product shows for the same reason.
 *
 * The name is `split_part(full_name, ' ', 1)`: the first token of whatever the operator typed. Arabic names may put a
 * title or a compound first ("عبد الله"), in which case this shows "عبد" — narrower than a passenger would like and
 * never wider than the driver agreed to. A driver with no `full_name` (it is `not null`, but an empty-after-trim row is
 * possible) yields `null`, and the page then says nothing rather than something empty.
 *
 * `verified` is `verification_status = 'verified'` — the same status the fleet console shows. It is a claim about the
 * document, not about the person, and the page labels it as such.
 */

create or replace function public.get_trip_public(p_code text, p_locale text default 'ar')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_trip public.trips%rowtype;
  v_locale text := case when p_locale = 'en' then 'en' else 'ar' end;
  v_payload jsonb;
begin
  select * into v_trip
  from public.trips t
  where t.code = upper(btrim(coalesce(p_code, '')))
    and t.status = 'published'
    and t.verification_status <> 'rejected';

  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'id', v_trip.id,
    'code', v_trip.code,
    'status', v_trip.status,
    'verificationStatus', v_trip.verification_status,
    'departureAt', v_trip.departure_at,
    'departureDate', v_trip.departure_date,
    'arriveEstimateMinutes', v_trip.arrive_estimate_minutes,
    'seatsTotal', v_trip.seats_total,
    'seatsAvailable', v_trip.seats_available,
    'bookingMode', v_trip.booking_mode,
    'pricingMode', v_trip.pricing_mode,
    'pricePerSeatYer', v_trip.price_per_seat_yer,
    'wholeTripPriceYer', v_trip.whole_trip_price_yer,
    'discount', jsonb_build_object(
      'kind', v_trip.discount_kind, 'value', v_trip.discount_value, 'scope', v_trip.discount_scope
    ),
    'genderPolicy', v_trip.gender_policy,
    'paymentPolicy', v_trip.payment_policy,
    'luggageAllowanceKg', v_trip.luggage_allowance_kg,
    'policies', v_trip.policies,
    'notes', v_trip.notes,
    'isFeatured', coalesce(v_trip.featured_until > now(), false),
    'hasDeparted', v_trip.departure_at <= now(),
    'operator', jsonb_build_object(
      'userId', v_trip.owner_user_id,
      'orgId', v_trip.owner_org_id,
      'name', case
        when v_trip.owner_org_id is not null then (
          select case when v_locale = 'ar' then o.name else coalesce(o.name_en, o.name) end
          from public.organizations o where o.id = v_trip.owner_org_id
        )
        else (select p.full_name from public.profiles p where p.id = v_trip.owner_user_id)
      end,
      'verified', case
        when v_trip.owner_org_id is not null then app.org_is_verified(v_trip.owner_org_id)
        else (select p.verification_status = 'verified' from public.profiles p where p.id = v_trip.owner_user_id)
      end
    ),
    -- The person driving. First name only, and nothing else from the row: see the note at the top of this file.
    'driver', (
      select jsonb_build_object(
        'name', nullif(btrim(split_part(d.full_name, ' ', 1)), ''),
        'verified', d.verification_status = 'verified'
      )
      from public.driver_profiles d where d.id = v_trip.driver_id
    ),
    'vehicle', (
      select jsonb_build_object(
        'label', v.make || ' ' || v.model || ' ' || v.model_year,
        'bodyType', v.body_type,
        'seatsTotal', v.seats_total,
        'airConditioning', v.air_conditioning,
        'wifi', v.wifi,
        'usbCharging', v.usb_charging
      )
      from public.vehicles v where v.id = v_trip.vehicle_id
    ),
    'origin', jsonb_build_object(
      'id', og.id, 'code', og.code,
      'name', case when v_locale = 'ar' then og.name_ar else coalesce(og.name_en, og.name_ar) end
    ),
    'destination', jsonb_build_object(
      'id', dg.id, 'code', dg.code,
      'name', case when v_locale = 'ar' then dg.name_ar else coalesce(dg.name_en, dg.name_ar) end
    ),
    'stops', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'seq', s.seq,
        'placeId', s.place_id,
        'governorateId', coalesce(s.governorate_id, pl.governorate_id),
        'name', case
          when v_locale = 'ar' then coalesce(s.name_ar, pl.name_ar, s.name_en, pl.name_en)
          else coalesce(s.name_en, pl.name_en, s.name_ar, pl.name_ar)
        end,
        'arriveOffsetMinutes', s.arrive_offset_minutes,
        'priceFromOriginYer', coalesce(s.price_from_origin_yer, v_trip.price_per_seat_yer),
        'fare', app.trip_total(v_trip, s.seq, 1)
      ) order by s.seq), '[]'::jsonb)
      from public.trip_stops s
      left join public.places pl on pl.id = s.place_id
      where s.trip_id = v_trip.id
    ),
    'fare', app.trip_total(v_trip, null, 1)
  )
  into v_payload
  from public.governorates og, public.governorates dg
  where og.id = v_trip.origin_governorate_id and dg.id = v_trip.destination_governorate_id;

  return v_payload;
end;
$$;
