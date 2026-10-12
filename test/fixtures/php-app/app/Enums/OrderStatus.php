<?php

namespace App\Enums;

use App\Contracts\HasLabel;

enum OrderStatus: string implements HasLabel
{
    case Pending = 'pending';
    case Paid = 'paid';

    const DEFAULT = self::Pending;

    public function label(): string
    {
        return match ($this) {
            self::Pending => 'Pending',
            self::Paid => 'Paid',
        };
    }
}
