-- Open assignments to interactive agents that the relay pushed to RabbitMQ before the Analyst became
-- interactive go back in the list. Under the claim rules this combination can't happen otherwise.
UPDATE events e SET delivery = 'pending', delivered_at = NULL
FROM nodes n
WHERE n.id = e.recipient AND e.kind = 'assign' AND e.state = 'open' AND e.delivery = 'delivered'
  AND n.kind = 'agent' AND coalesce((n.attrs->>'interactive')::boolean, false);
