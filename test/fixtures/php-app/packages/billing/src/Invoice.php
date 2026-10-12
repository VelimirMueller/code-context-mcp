<?php

namespace Acme\Billing;

final readonly class Invoice
{
    public function __construct(public InvoiceNumber $number, public int $customerId) {}
}
