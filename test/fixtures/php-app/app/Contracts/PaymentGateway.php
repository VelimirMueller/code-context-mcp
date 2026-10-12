<?php

namespace App\Contracts;

/**
 * Same namespace as HasEvents: extends it without a use statement.
 */
interface PaymentGateway extends HasEvents
{
    public function charge(int $cents): bool;
}
