<?php

namespace Acme\Billing\Gateways;

use App\Contracts\PaymentGateway;

class FakeGateway implements PaymentGateway
{
    public function charge(int $cents): bool
    {
        return true;
    }

    public function events(): array
    {
        return [];
    }
}
