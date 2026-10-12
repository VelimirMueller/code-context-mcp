<?php

namespace App\Services;

use App\Contracts\HasEvents;
use App\Contracts\PaymentGateway;
use App\Models\{Order, User as Customer};
use Acme\Billing\Invoice;
use Illuminate\Support\Facades\Log;
use function App\Support\format_money;
use const App\Support\DEFAULT_CURRENCY;

// new \App\Decoys\Decoy() in a line comment
# use App\Decoys\Decoy;
/**
 * @see \App\Decoys\Decoy::class in a docblock
 */
final class OrderService extends BaseService implements HasEvents
{
    private const LABEL = 'App\Decoys\Decoy';

    public function __construct(private readonly PaymentGateway $gateway) {}

    public function place(Customer $customer, Order $order): Invoice
    {
        $number = new \Acme\Billing\InvoiceNumber();
        $note = "Decoy {$order->id} \App\Decoys\Decoy::class";
        $text = <<<EOT
            new \App\Decoys\Decoy()
            EOT;
        $raw = <<<'NOW'
            \App\Decoys\Decoy::make()
            NOW;
        Log::info(format_money(100, DEFAULT_CURRENCY));
        $this->gateway->charge(100);

        return new Invoice($number, $customer->id);
    }

    public function events(): array
    {
        return [];
    }

    protected function name(): string
    {
        return 'orders';
    }
}
