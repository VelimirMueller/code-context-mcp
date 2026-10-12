<?php

namespace App\Support;

const DEFAULT_CURRENCY = 'EUR';

function format_money(int $cents, string $currency = DEFAULT_CURRENCY): string
{
    return sprintf('%d %s', $cents, $currency);
}
